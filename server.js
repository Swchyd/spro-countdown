// SPro Countdown — offline stage server.
//
// Serves the app to every device on the local network and relays timer state
// between them. No internet, no router.
//
//   node server.js          run it on its own
//   require("./server")     embed it (the desktop app does this)
//
// Two listeners share one handler and one pile of state:
//
//   http  :8080   the operator's own window (localhost is already a secure
//                 origin) and the one-time CA download for the iPad
//   https :8443   what the iPad installs from — Safari will not register a
//                 service worker on an insecure origin, and without one there
//                 is no offline cache
//
// Transport is Server-Sent Events rather than WebSockets — the payload is a
// few hundred bytes a handful of times per service, EventSource reconnects on
// its own, and it needs no protocol code of our own.

var http = require("http");
var https = require("https");
var fs = require("fs");
var path = require("path");
var os = require("os");

// Only these ever leave the machine. An allowlist rather than a path check,
// so node_modules, the private key and anything else in this folder stays put.
var ASSETS = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/sw.js": ["sw.js", "text/javascript; charset=utf-8"],
  "/peerjs.min.js": ["peerjs.min.js", "text/javascript; charset=utf-8"],
  "/manifest.json": ["manifest.json", "application/manifest+json; charset=utf-8"],
  "/icon-180.png": ["icon-180.png", "image/png"]
};

function createStage(conf) {
  var state = null;    // last snapshot pushed by the operator
  var clients = [];    // open SSE responses, each { res, role }

  function addresses() {
    var out = [];
    var ifs = os.networkInterfaces();
    Object.keys(ifs).forEach(function (name) {
      (ifs[name] || []).forEach(function (a) {
        if (a.family !== "IPv4" || a.internal) return;
        out.push({
          iface: name,
          app: conf.tls
            ? "https://" + a.address + ":" + conf.tlsPort
            : "http://" + a.address + ":" + conf.port,
          ca: "http://" + a.address + ":" + conf.port + "/ca"
        });
      });
    });
    return out;
  }

  function displayCount() {
    return clients.filter(function (c) { return c.role === "display"; }).length;
  }

  function fanout(obj) {
    var frame = "data: " + JSON.stringify(obj) + "\n\n";
    clients.forEach(function (c) {
      try { c.res.write(frame); } catch (e) {}
    });
  }

  function noCache(res, type) {
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store, no-cache, must-revalidate"
    });
  }

  function handler(req, res) {
    var u = new URL(req.url, "http://localhost");
    var p = u.pathname;

    // ---- clock reference ------------------------------------------------
    // The operator runs on this machine, so this clock is the operator's
    // clock. Displays sync against it and then render locally.
    if (p === "/time") {
      noCache(res, "application/json; charset=utf-8");
      res.end(JSON.stringify({ s: Date.now() }));
      return;
    }

    // ---- where to point the iPad ----------------------------------------
    if (p === "/info") {
      noCache(res, "application/json; charset=utf-8");
      res.end(JSON.stringify({
        addresses: addresses(),
        port: conf.port,
        tlsPort: conf.tlsPort,
        secure: !!conf.tls
      }));
      return;
    }

    // ---- one-time trust anchor for the iPad ------------------------------
    // Served over plain HTTP on purpose: this is what makes HTTPS trusted,
    // so it cannot itself depend on HTTPS being trusted yet.
    if (p === "/ca") {
      if (!conf.tls) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("HTTPS is not running");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/x-x509-ca-cert",
        "Content-Disposition": 'attachment; filename="SPro-Countdown-CA.cer"',
        "Cache-Control": "no-store"
      });
      res.end(conf.tls.caDer);
      return;
    }

    // ---- operator pushes a state snapshot --------------------------------
    if (p === "/state" && req.method === "POST") {
      var body = "";
      req.on("data", function (c) {
        body += c;
        if (body.length > 65536) req.destroy();
      });
      req.on("end", function () {
        try { state = JSON.parse(body); } catch (e) {
          res.writeHead(400).end();
          return;
        }
        fanout({ t: "state", d: state });
        res.writeHead(204).end();
      });
      return;
    }

    // ---- live stream to every connected device ---------------------------
    if (p === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
      });
      res.write("retry: 1000\n\n");

      var client = { res: res, role: u.searchParams.get("role") === "op" ? "op" : "display" };
      clients.push(client);

      if (state) res.write("data: " + JSON.stringify({ t: "state", d: state }) + "\n\n");
      fanout({ t: "peers", n: displayCount() });

      // Sleeping Wi-Fi radios drop idle sockets; this keeps the pipe warm.
      var keep = setInterval(function () {
        try { res.write(": keepalive\n\n"); } catch (e) {}
      }, 15000);

      var gone = function () {
        clearInterval(keep);
        clients = clients.filter(function (c) { return c !== client; });
        fanout({ t: "peers", n: displayCount() });
      };
      req.on("close", gone);
      req.on("error", gone);
      return;
    }

    // ---- static files ----------------------------------------------------
    var asset = ASSETS[p];
    if (!asset || (req.method !== "GET" && req.method !== "HEAD")) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    fs.readFile(path.join(__dirname, asset[0]), function (err, data) {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": asset[1], "Cache-Control": "no-cache" });
      res.end(req.method === "HEAD" ? undefined : data);
    });
  }

  return { handler: handler, addresses: addresses };
}

// Starts listening. onError is called instead of throwing, so an embedding
// app (the Electron shell) can show the problem in a dialog.
function start(opts) {
  opts = opts || {};
  var port = Number(opts.port || process.env.PORT || 8080);
  var tlsPort = Number(opts.tlsPort || process.env.TLS_PORT || 8443);

  // TLS is a nicety, not a requirement — if issuing fails, HTTP still works
  // and the operator can still run the service.
  var tls = null, tlsError = null;
  try {
    tls = require("./certs.js").ensure();
  } catch (e) {
    tlsError = e;
  }

  var stage = createStage({ port: port, tlsPort: tlsPort, tls: tls });
  var httpServer = http.createServer(stage.handler);
  var httpsServer = tls
    ? https.createServer({ key: tls.key, cert: tls.cert }, stage.handler)
    : null;

  var pending = httpsServer ? 2 : 1;
  var failed = false;

  function fail(err) {
    if (failed) return;
    failed = true;
    if (opts.onError) opts.onError(err);
    else throw err;
  }

  function up() {
    if (failed || --pending > 0) return;
    if (opts.onReady) {
      opts.onReady({
        addresses: stage.addresses,
        port: port,
        tlsPort: tlsPort,
        secure: !!tls,
        tlsError: tlsError,
        freshCA: tls && tls.freshCA,
        close: function () {
          try { httpServer.close(); } catch (e) {}
          if (httpsServer) { try { httpsServer.close(); } catch (e) {} }
        }
      });
    }
  }

  httpServer.on("error", fail);
  httpServer.listen(port, "0.0.0.0", up);
  if (httpsServer) {
    httpsServer.on("error", fail);
    httpsServer.listen(tlsPort, "0.0.0.0", up);
  }
}

module.exports = { start: start };

// ---- run directly: print the banner and stay up ------------------------
if (require.main === module) {
  start({
    onReady: function (s) {
      var list = s.addresses();
      console.log("");
      console.log("  ================================================");
      console.log("   SPro Countdown  -  server running");
      console.log("  ================================================");
      console.log("");
      console.log("   On this laptop (operator):");
      console.log("      http://localhost:" + s.port);
      console.log("");
      if (!s.secure) {
        console.log("   HTTPS is OFF" + (s.tlsError ? " (" + s.tlsError.message + ")" : ""));
        console.log("   The iPad can still connect, but cannot cache the app.");
        console.log("");
      }
      if (list.length) {
        console.log("   On the iPad:");
        list.forEach(function (a) {
          console.log("      " + a.app + "     [" + a.iface + "]");
        });
        if (s.secure) {
          console.log("");
          console.log("   First time only - install the trust profile from:");
          list.forEach(function (a) { console.log("      " + a.ca); });
        }
      } else {
        console.log("   No network found yet.");
        console.log("   Turn on Mobile Hotspot, then restart this window.");
      }
      console.log("");
      console.log("   Keep this window open during the service.");
      console.log("   Press Ctrl+C to stop.");
      console.log("");
    },
    onError: function (err) {
      console.log("");
      if (err.code === "EADDRINUSE") {
        console.log("  Port is already in use - another copy is probably running.");
        console.log("  Close it, or pick another port:   set PORT=8081 && node server.js");
      } else {
        console.log("  Server error: " + err.message);
      }
      console.log("");
      process.exit(1);
    }
  });
}
