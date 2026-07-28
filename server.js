// SPro Countdown — offline stage server.
//
// Serves the app to every device on the local network and relays timer state
// between them. No internet, no router, no npm install: plain Node, plain HTTP.
//
//   node server.js          run it on its own
//   require("./server")     embed it (the desktop app does this)
//
// Transport is Server-Sent Events rather than WebSockets — the payload is a
// few hundred bytes a handful of times per service, EventSource reconnects on
// its own, and it keeps this file dependency-free.

var http = require("http");
var fs = require("fs");
var path = require("path");
var os = require("os");

// Only these ever leave the machine. An allowlist rather than a path check,
// so node_modules and anything else dropped in this folder stays private.
var ASSETS = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/sw.js": ["sw.js", "text/javascript; charset=utf-8"],
  "/peerjs.min.js": ["peerjs.min.js", "text/javascript; charset=utf-8"],
  "/manifest.json": ["manifest.json", "application/manifest+json; charset=utf-8"],
  "/icon-180.png": ["icon-180.png", "image/png"]
};

function createStage(port) {
  var state = null;    // last snapshot pushed by the operator
  var clients = [];    // open SSE responses, each { res, role }

  function lanURLs() {
    var out = [];
    var ifs = os.networkInterfaces();
    Object.keys(ifs).forEach(function (name) {
      (ifs[name] || []).forEach(function (a) {
        if (a.family === "IPv4" && !a.internal) {
          out.push({ iface: name, url: "http://" + a.address + ":" + port });
        }
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

  var server = http.createServer(function (req, res) {
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
      res.end(JSON.stringify({ urls: lanURLs(), port: port }));
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
  });

  server.lanURLs = lanURLs;
  server.port = port;
  return server;
}

// Starts listening. onError is called instead of throwing, so an embedding
// app (the Electron shell) can show the problem in a dialog.
function start(opts) {
  opts = opts || {};
  var port = Number(opts.port || process.env.PORT || 8080);
  var server = createStage(port);

  server.on("error", function (err) {
    if (opts.onError) opts.onError(err);
    else throw err;
  });

  server.listen(port, "0.0.0.0", function () {
    if (opts.onReady) opts.onReady(server);
  });

  return server;
}

module.exports = { start: start };

// ---- run directly: print the banner and stay up ------------------------
if (require.main === module) {
  start({
    onReady: function (server) {
      var urls = server.lanURLs();
      console.log("");
      console.log("  ================================================");
      console.log("   SPro Countdown  -  server running");
      console.log("  ================================================");
      console.log("");
      console.log("   On this laptop (operator):");
      console.log("      http://localhost:" + server.port);
      console.log("");
      if (urls.length) {
        console.log("   On the iPad (display) - type one of these:");
        urls.forEach(function (u) {
          console.log("      " + u.url + "     [" + u.iface + "]");
        });
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
