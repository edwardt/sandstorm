// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// This file implements logic that we place in front of our main Meteor application,
// including routing of requests to proxies and handling of static web publishing.

const Url = Npm.require("url");
const Fs = Npm.require("fs");
const Dns = Npm.require("dns");
const Promise = Npm.require("es6-promise").Promise;
const Future = Npm.require("fibers/future");
const Http = Npm.require("http");

const HOSTNAME = Url.parse(process.env.ROOT_URL).hostname;
const DDP_HOSTNAME = process.env.DDP_DEFAULT_CONNECTION_URL &&
    Url.parse(process.env.DDP_DEFAULT_CONNECTION_URL).hostname;
const CACHE_TTL_SECONDS = 30;  // 30 seconds.  Cache-Control expects units of seconds, not millis.
const DNS_CACHE_TTL = CACHE_TTL_SECONDS * 1000; // DNS cache is in millis.

const staticHandlers = {};
// Maps grain public IDs to Connect handlers.
// TODO(perf): Garbage-collect this map?

const dnsCache = {};
// Unfortunately, node's DNS library doesn't cache results, so we do our own caching.
// Unfortunately, node's DNS library also dosen't give us TTLs. So, we'll cache for
// DNS_CACHE_TTL (a relatively small value) and rely on the upstream DNS server to implement
// better caching.

function isSandstormShell(hostname) {
  // Is this hostname mapped to the Sandstorm shell?

  return (hostname === HOSTNAME || (DDP_HOSTNAME && hostname === DDP_HOSTNAME));
}

const mime = Connect.static.mime;

function wwwHandlerForGrain(grainId) {
  return (request, response, cb) => {
    let path = request.url;

    // If a directory, open 'index.html'.
    if (path.slice(-1) === "/") {
      path = path + "index.html";
    }

    // Strip leading '/'.
    if (path[0] === "/") path = path.slice(1);

    // Strip query.
    path = path.split("?")[0];

    let type = mime.lookup(path);
    const charset = mime.charsets.lookup(type);
    if (charset) {
      type = type + "; charset=" + charset;
    } else if (type === "application/json") {
      // HACK: Apparently the MIME module does not assume UTF-8 for JSON. :(
      type = type + "; charset=utf-8";
    }

    // TODO(perf): Automatically gzip text content? Use Express's 'compress' middleware for this?
    //   Note that nginx will also auto-compress things...

    response.setHeader("Content-Type", type);
    response.setHeader("Cache-Control", "public, max-age=" + CACHE_TTL_SECONDS);

    if (path === "apps/index.json" ||
        path.match(/apps\/[a-z0-9]{52}[.]json/) ||
        path === "experimental/index.json" ||
        path.match(/experimental\/[a-z0-9]{52}[.]json/)) {
      // TODO(cleanup): Extra special terrible hack: The app index needs to serve these JSON files
      //   cross-origin. We could almost just make all web sites allow cross-origin since generally
      //   web publishing is meant to publish public content. There is one case where this is
      //   problematic, though: sites behind a firewall. Those sites could potentially be read
      //   by outside sites if CORS is enabled on them. Some day we should make it so apps can
      //   explicitly opt-in to allowing cross-origin queries but that day is not today.
      response.setHeader("Access-Control-Allow-Origin", "*");
    }

    const stream = new ResponseStream(response, 200, "OK");

    globalBackend.useGrain(grainId, (supervisor) => {
      return supervisor.getWwwFileHack(path, stream).then((result) => {
        // jscs:disable disallowQuotedKeysInObjects
        const status = result.status;
        if (status === "file") {
          if (!stream.ended) {
            console.error("getWwwFileHack didn't write file to stream");
            if (!stream.started) {
              response.writeHead(500, {
                "Content-Type": "text/plain",
              });
              response.end("Internal server error");
            } else {
              response.end();
            }
          }
        } else if (status === "directory") {
          if (stream.started) {
            console.error("getWwwFileHack wrote to stream for directory");
            if (!stream.ended) {
              response.end();
            }
          } else {
            response.writeHead(303, {
              "Content-Type": "text/plain",
              "Location": "/" + path + "/",
              "Cache-Control": "public, max-age=" + CACHE_TTL_SECONDS,
            });
            response.end("redirect: /" + path + "/");
          }
        } else if (status === "notFound") {
          if (stream.started) {
            console.error("getWwwFileHack wrote to stream for notFound");
            if (!stream.ended) {
              response.end();
            }
          } else {
            response.writeHead(404, {
              "Content-Type": "text/plain",
            });
            response.end("404 not found: /" + path);
          }
        } else {
          console.error("didn't understand result of getWwwFileHack:", status);
          if (!stream.started) {
            response.writeHead(500, {
              "Content-Type": "text/plain",
            });
            response.end("Internal server error");
          }
        }
      });
    }).catch((err) => {
      console.error(err.stack);
    });
  };
}

function writeErrorResponse(res, err) {
  let status = 500;
  if (err instanceof Meteor.Error && typeof err.error === "number" &&
      err.error >= 400 && err.error < 600) {
    status = err.error;
  } else if (err.httpErrorCode) {
    status = err.httpErrorCode;
  }

  // Log errors that are our fault, but not errors that are the client's fault.
  if (status >= 500) console.error(err.stack);

  res.writeHead(status, { "Content-Type": err.htmlMessage ? "text/html" : "text/plain" });
  res.end(err.htmlMessage || err.message);
}

const PNG_MAGIC = new Buffer([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const JPEG_MAGIC = new Buffer([0xFF, 0xD8, 0xFF]);

function checkMagic(buf, magic) {
  if (buf.length < magic.length) return false;

  for (let i = 0; i < magic.length; i++) {
    if (buf[i] != magic[i]) return false;
  }

  return true;
}

function serveSelfTest(req, res) {
  try {
    if (req.method === "GET" &&
        req.url === "/") {
      const content = new Buffer("Self-test OK.");

      // Convert the ROOT_URL to something that is a valid origin.
      let rootUrlAsOrigin = process.env.ROOT_URL;
      if (rootUrlAsOrigin.slice(-1) === "/") {
        rootUrlAsOrigin = rootUrlAsOrigin.slice(0, -1);
      }

      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Content-Length": content.length,
        "Access-Control-Allow-Origin": rootUrlAsOrigin,
      });
      res.end(content);
    } else {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad request to self-test subdomain.");
      return;
    }
  } catch (err) {
    console.log("WARNING: An error occurred while serving self-test; proceeding anyway:", err);
  }
}

function serveStaticAsset(req, res) {
  inMeteor(() => {
    if (req.method === "GET") {
      // jscs:disable validateQuoteMarks
      const assetCspHeader = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
      if (req.headers['if-none-match'] === 'permanent') {
        // Cache never invalidates since we use a new URL for every resource.
        res.writeHead(304, {
          'Cache-Control': 'public, max-age=31536000',
          'ETag': 'permanent',

          // To be safe, send these again, although it shouldn't be necessary.
          'Content-Security-Policy': assetCspHeader,
          'Access-Control-Allow-Origin': '*',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end();
        return;
      }

      const url = Url.parse(req.url);
      const asset = globalDb.getStaticAsset(url.pathname.slice(1));

      if (asset) {
        const headers = {
          'Content-Type': asset.mimeType,
          'Content-Length': asset.content.length,

          // Assets can be cached forever because each one has a unique ID.
          'Cache-Control': 'public, max-age=31536000',

          // Since different resources get different URLs, we can use a static etag.
          'ETag': 'permanent',

          // Set strict Content-Security-Policy to prevent static assets from executing any script
          // or doing basically anything when browsed to directly. The static assets host is not
          // intended to serve HTML. Mostly, it serves images and javascript -- note that setting
          // the CSP header on Javascript files does not prevent other hosts from voluntarily
          // specifying these scripts in <script> tags.
          'Content-Security-Policy': assetCspHeader,

          // Allow any host to fetch these assets. This is safe since requests to this host are
          // totally side-effect-free and the asset ID acts as a capability to prevent loading
          // assets you're not supposed to know about.
          'Access-Control-Allow-Origin': '*',

          // Extra protection against content type trickery.
          'X-Content-Type-Options': 'nosniff',
        };

        if (asset.encoding) {
          headers['Content-Encoding'] = asset.encoding;
        }

        res.writeHead(200, headers);
        res.end(asset.content);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
      }
    } else if (req.method === 'POST') {
      res.setHeader('Access-Control-Allow-Origin', '*');

      const url = Url.parse(req.url);
      const purpose = globalDb.fulfillAssetUpload(url.pathname.slice(1));
      if (!purpose) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Upload token not found or expired.');
        return;
      }

      const userId = purpose.profilePicture.userId;
      const identityId = purpose.profilePicture.identityId;
      check(userId, String);
      check(identityId, String);

      const buffers = [];
      let totalSize = 0;
      const done = new Future();
      req.on('data', (buf) => {
        totalSize += buf.length;
        if (totalSize <= (64 * 1024)) {
          buffers.push(buf);
        }
      });
      req.on('end', done.return.bind(done));
      req.on('error', done.throw.bind(done));
      done.wait();

      if (totalSize > (64 * 1024)) {
        // TODO(soon): Resize the image ourselves.
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Picture too large; please use an image under 64 KiB.');
        return;
      }

      const content = Buffer.concat(buffers);
      let type;
      if (checkMagic(content, PNG_MAGIC)) {
        type = 'image/png';
      } else if (checkMagic(content, JPEG_MAGIC)) {
        type = 'image/jpeg';
      } else {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Image must be PNG or JPEG.');
        return;
      }

      const assetId = globalDb.addStaticAsset({ mimeType: type }, content);
      const old = Meteor.users.findAndModify({
        query: { '_id': identityId },
        update: { $set: { 'profile.picture': assetId } },
        fields: { 'profile.picture': 1 },
      });

      if (old && old.profile && old.profile.picture) {
        globalDb.unrefStaticAsset(old.profile.picture);
      }

      res.writeHead(204, {});
      res.end();
    } else if (req.method === 'OPTIONS') {
      const requestedHeaders = req.headers['access-control-request-headers'];
      if (requestedHeaders) {
        res.setHeader('Access-Control-Allow-Headers', requestedHeaders);
      }

      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        'Access-Control-Max-Age': '3600',
      });
      res.end();
    } else {
      res.writeHead(405, 'Method Not Allowed', {
        'Allow': 'GET, POST, OPTIONS',
        'Content-Type': 'text/plain',
      });
      res.end('405 Method Not Allowed: ' + req.method);
    }
  }).catch((err) => {
    writeErrorResponse(res, err);
  });
}

Meteor.startup(() => {

  const meteorUpgradeListeners = WebApp.httpServer.listeners('upgrade');
  WebApp.httpServer.removeAllListeners('upgrade');

  WebApp.httpServer.on('upgrade', (req, socket, head) => {
    Promise.resolve(undefined).then(() => {
      if (!req.headers.host) {
        throw new Meteor.Error(400, 'Missing Host header');
      } else if (isSandstormShell(req.headers.host.split(':')[0])) {
        // Go on to Meteor.
        for (let ii = 0; ii < meteorUpgradeListeners.length; ++ii) {
          meteorUpgradeListeners[ii](req, socket, head);
        }

        return true;
      } else {
        const id = matchWildcardHost(req.headers.host);
        if (id) {
          return tryProxyUpgrade(id, req, socket, head);
        } else {
          return false;
        }
      }
    }).then((handled) => {
      if (!handled) socket.destroy();
    }).catch((err) => {
      console.error('WebSocket event handler failed:', err.stack);
      socket.destroy();
    });
  });

  // BlackrockPayments is only defined in the Blackrock build of Sandstorm.
  if (global.BlackrockPayments) { // Have to check with global, because it could be undefined.
    WebApp.rawConnectHandlers.use(BlackrockPayments.makeConnectHandler(globalDb));
  }

  // This function serves responses on Sandstorm's main HTTP/HTTPS
  // port.
  const serveMeteorOrStaticPublishing = (req, res, next) => {
    return dispatchToMeteorOrStaticPublishing(req, res, next, false);
  };

  // "Alternate ports" are ports other than the main HTTP or HTTPS
  // port. For requests to the shell & grains, we redirect to the main
  // port. For static publishing, we serve it.
  //
  // They are bound to FD #5 and higher.

  function getNumberOfAlternatePorts() {
    const numPorts = process.env.PORT.split(',').length;
    const numAlternatePorts = numPorts - 1;
    return numAlternatePorts;
  };

  const canonicalizeShellOrWildcardUrl = (hostname, url) => {
    // Start with ROOT_URL, apply host & path from inbound URL, then
    // redirect.
    let targetUrl = Url.parse(process.env.ROOT_URL);

    // Retain the protocol & port from ROOT_URL but use the inbound
    // hostname.
    targetUrl.host = hostname + ':' + targetUrl.port;

    // The following allows to avoid decoding + re-encoding query
    // string parameters, if provided.
    targetUrl = Url.resolve(Url.format(targetUrl), url);
    return targetUrl;
  };

  const redirectToMeteorOrServeStaticPublishing = (req, res, next) => {
    return dispatchToMeteorOrStaticPublishing(req, res, next, true);
  };

  for (let i = 0; i < getNumberOfAlternatePorts(); i++) {
    // Call createServerForSandstorm() to skip our monkey patching.
    const alternatePortServer = Http.createServerForSandstorm(redirectToMeteorOrServeStaticPublishing);
    alternatePortServer.listen({ fd: i + 5 });
  }

  const dispatchToMeteorOrStaticPublishing = (req, res, next, redirectRatherThanServeShell) => {
    if (!req.headers.host) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing Host header');
      return;
    }

    const hostname = req.headers.host.split(':')[0];
    if (isSandstormShell(hostname)) {
      // Go on to Meteor, or serve a redirect.
      if (redirectRatherThanServeShell) {
        res.writeHead(302, { 'Location': canonicalizeShellOrWildcardUrl(hostname, req.url) });
        res.end();
        return;
      } else {
        return next();
      }
    }

    // This is not our main host. See if it's a member of the wildcard.
    let publicIdPromise;

    const id = matchWildcardHost(req.headers.host);
    if (id) {
      // Match!
      if (redirectRatherThanServeShell) {
        res.writeHead(302, { 'Location': canonicalizeShellOrWildcardUrl(hostname, req.url) });
        res.end();
        return;
      }

      if (id === 'static') {
        // Static assets domain.
        serveStaticAsset(req, res);
        return;
      }

      if (id.match(/^selftest-/)) {
        // Self test domain pattern. Starts w/ hyphen to avoid ambiguity with grain session/static
        // publishing wildcard hosts.
        serveSelfTest(req, res);
        return;
      }

      // Try to route the request to a session.
      publicIdPromise = tryProxyRequest(id, req, res).then((handled) => {
        if (handled) {
          return null;
        } else {
          return id;
        }
      });
    } else {
      // Not a wildcard host. Perhaps it is a custom host.
      publicIdPromise = lookupPublicIdFromDns(hostname);
    }

    publicIdPromise.then((publicId) => {
      if (publicId) {
        return Promise.resolve(undefined).then(() => {
          const handler = staticHandlers[publicId];
          if (handler) {
            return handler;
          } else {
            // We don't have a handler for this publicId, so look it up in the grain DB.
            return inMeteor(() => {
              const grain = Grains.findOne({ publicId: publicId }, { fields: { _id: 1 } });
              if (!grain) {
                throw new Meteor.Error(404, 'No such grain for public ID: ' + publicId);
              }

              const grainId = grain._id;
              return staticHandlers[publicId] = wwwHandlerForGrain(grainId);
            });
          }
        }).then((handler) => {
          handler(req, res, (err) => {
            if (err) {
              next(err);
            } else {
              res.writeHead(404, { 'Content-Type': 'text/plain' });
              res.end('404 not found: ' + req.url);
            }
          });
        });
      } else {
        return Promise.resolve(undefined);
      }
    }).catch((err) => {
      writeErrorResponse(res, err);
    });
  };

  WebApp.rawConnectHandlers.use(serveMeteorOrStaticPublishing);
});

const errorTxtMapping = {};
errorTxtMapping[Dns.NOTFOUND] = '<p>' +
    'If you were trying to configure static publishing for a blog or website, powered ' +
    'by a Sandstorm app hosted at this server, you either have not added DNS TXT records ' +
    'correctly, or the DNS cache has not updated yet (may take a while, like 5 minutes to one ' +
    'hour).</p>';
errorTxtMapping[Dns.NODATA] = errorTxtMapping[Dns.NOTFOUND];
errorTxtMapping[Dns.TIMEOUT] = '<p>' +
    'The DNS query has timed out, which may be a sign of poorly configured DNS on the server.</p>';
errorTxtMapping[Dns.CONNREFUSED] = '<p>' +
    'The DNS server refused the connection, which means either your DNS server is down/unreachable, ' +
    'or the server has misconfigured their DNS.</p>';

function lookupPublicIdFromDns(hostname) {
  // Given a hostname, determine its public ID.
  // We look for a TXT record indicating the public ID. Unfortunately, according to spec, a single
  // hostname cannot have both a CNAME and a TXT record, because a TXT lookup on a CNAME'd host
  // should actually be redirected to the CNAME, just like an A lookup would be. In practice lots
  // of DNS software actually allows TXT records on CNAMEs, and it seems to work, but some software
  // does not allow it and it's explicitly disallowed by the spec. Therefore, we instead look for
  // the TXT record on a subdomain.
  //
  // I also considered having the CNAME itself point to <publicId>.<hostname>, where
  // *.<hostname> is in turn a CNAME for the Sandstorm server. This approach seemed elegant at
  // first, but has a number of problems, the biggest being that it breaks the ability to place a
  // CDN like CloudFlare in front of the site.

  const cache = dnsCache[hostname];
  if (cache && Date.now() < cache.expiration) {
    return Promise.resolve(cache.value);
  }

  return new Promise((resolve, reject) => {
    Dns.resolveTxt('sandstorm-www.' + hostname, (err, records) => {
      if (err) {
        const errorMsg = errorTxtMapping[err.code] || '';
        const error = new Error(
          'Error looking up DNS TXT records for host "' + hostname + '": ' + err.message);
        error.htmlMessage =
          '<style type="text/css">h2, h3, p { max-width: 600px; }</style>' +
          '<h2>Sandstorm static publishing needs further configuration (or wrong URL)</h2>' +
          errorMsg +
          '<p>To visit this Sandstorm server\'s main interface, go to: <a href=\'' + process.env.ROOT_URL + '\'>' +
          process.env.ROOT_URL + '</a></p>' +
          '<h3>DNS details</h3>' +
          '<p>Error looking up DNS TXT records for host "' + hostname + '": ' + err.message + '</p>' +
          '<p>If you have the <tt>dig</tt> tool, you can run this command to learn more:</p>' +
          '<p><tt>dig TXT sandstorm-www.' + hostname + '</tt></p>' +
          '<h3>Changing the server URL, or troubleshooting OAuth login</h3>' +
          '<p>If you are the server admin and want to use this address as the main interface, ' +
          'edit /opt/sandstorm/sandstorm.conf, modify the BASE_URL setting, and restart ' +
          'Sandstorm.</p>' +
          '<p>If you got here after trying to log in via OAuth (e.g. through GitHub or Google), ' +
          'the problem is probably that the OAuth callback URL was set wrong. You need to ' +
          'update it through the respective login provider\'s management console. The ' +
          'easiest way to do that is to run <tt>sudo sandstorm admin-token</tt>, then ' +
          'reconfigure the OAuth provider.</p>';
        error.httpErrorCode = (_.contains(['ENOTFOUND', 'ENODATA'], err.code)) ? 404 : 500;
        reject(error);
      } else if (records.length !== 1) {
        reject(new Error('Host "sandstorm-www.' + hostname + '" must have exactly one TXT record.'));
      } else {
        const result = records[0];
        dnsCache[hostname] = { value: result, expiration: Date.now() + DNS_CACHE_TTL };
        resolve(result);
      }
    });
  });
}
