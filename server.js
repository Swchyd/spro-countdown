// SPro Countdown — offline stage server.
//
// Serves the app to every device on the local network and relays timer state
// between them. No internet, no router, no npm install: plain Node, plain HTTP.
//
//   run:  node server.js       (or double-click start-timer.bat)
//
// Transport is Server-Sent Events rather than WebSockets — the payload is a
// few hundred bytes a handful of times per service, EventSource reconnects on
// its own, and it keeps this file dependency-free.

var http = require("http");
var fs = require("fs");
var path = require("path");
var os = require("os");

var ROOT = __dirname;
var PORT = Number(process.env.PORT) || 8080;

var TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

var state = null;      // last snapshot pushed by the operator
var displays = [];     // SSE responses, each { res, role }

function lanURLs() {
  var out = [];
  var ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(function (name) {
    (ifs[name] || []).forEach(function (a) {
      if (a.family === "IPv4" && !a.internal) {
        out.push({ iface: name, url: "http://" + a.address + ":" + PORT });
      }
    });
  });
  return out;
}

function displayCount() {
  return displays.filter(function (c) { return c.role === "display"; }).length;
}

function fanout(obj) {
  var frame = "data: " + JSON.stringify(obj) + "\n\n";
  displays.forEach(function (c) {
    try { c.res.write(frame); } catch (e) {}
  });
}

function announcePeers() {
  fanout({ t: "peers", n: displayCount() });
}

function noCache(res, type) {
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Access-Control-Allow-Origin": "*"
  });
}

var server = http.createServer(function (req, res) {
  var u = new URL(req.url, "http://localhost");
  var p = u.pathname;

  // ---- clock reference -------------------------------------------------
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
    res.end(JSON.stringify({ urls: lanURLs(), port: PORT }));
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
      var parsed;
      try { parsed = JSON.parse(body); } catch (e) {
        res.writeHead(400).end();
        return;
      }
      state = parsed;
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
    displays.push(client);

    if (state) res.write("data: " + JSON.stringify({ t: "state", d: state }) + "\n\n");
    announcePeers();

    // Proxies and sleeping Wi-Fi radios drop idle sockets; this keeps it warm.
    var keep = setInterval(function () {
      try { res.write(": keepalive\n\n"); } catch (e) {}
    }, 15000);

    var gone = function () {
      clearInterval(keep);
      displays = displays.filter(function (c) { return c !== client; });
      announcePeers();
    };
    req.on("close", gone);
    req.on("error", gone);
    return;
  }

  // ---- static files ----------------------------------------------------
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }

  var rel = decodeURIComponent(p);
  if (rel === "/") rel = "/index.html";
  var file = path.join(ROOT, rel);
  if (file.indexOf(ROOT) !== 0) {
    res.writeHead(403).end();
    return;
  }

  fs.readFile(file, function (err, data) {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    res.end(req.method === "HEAD" ? undefined : data);
  });
});

server.on("error", function (err) {
  if (err.code === "EADDRINUSE") {
    console.log("");
    console.log("  Port " + PORT + " is already in use.");
    console.log("  Another copy of the server is probably running already.");
    console.log("  Close it, or start this one on another port:");
    console.log("");
    console.log("      set PORT=8081 && node server.js");
    console.log("");
  } else {
    console.log("  Server error: " + err.message);
  }
  process.exit(1);
});

server.listen(PORT, "0.0.0.0", function () {
  var urls = lanURLs();
  console.log("");
  console.log("  ================================================");
  console.log("   SPro Countdown  -  server running");
  console.log("  ================================================");
  console.log("");
  console.log("   On this laptop (operator):");
  console.log("      http://localhost:" + PORT);
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
});
