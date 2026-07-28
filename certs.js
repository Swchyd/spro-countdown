// Certificates for the local HTTPS server.
//
// Safari only registers a service worker on a secure origin, and without one
// the iPad cannot cache the app for offline use. A plain LAN IP is not a
// secure origin, so the stage server needs real TLS — which on a network with
// no internet means signing our own.
//
// The split matters: the CA is generated once and never changes, so the trust
// profile installed on the iPad stays valid forever. The server certificate is
// cheap and gets reissued whenever the machine's addresses change — a new
// hotspot IP costs nothing on the iPad side.

var fs = require("fs");
var path = require("path");
var os = require("os");
var crypto = require("crypto");
var forge = require("node-forge");

var DIR = path.join(__dirname, ".certs");
var CA_CERT = path.join(DIR, "ca.crt.pem");
var CA_KEY = path.join(DIR, "ca.key.pem");
var TLS_CERT = path.join(DIR, "server.crt.pem");
var TLS_KEY = path.join(DIR, "server.key.pem");
var TLS_META = path.join(DIR, "server.json");

// iOS rejects TLS certificates valid for more than 398 days. notBefore is
// backdated a day to tolerate clock skew, so keep a margin under the limit.
var LEAF_DAYS = 390;
var CA_YEARS = 10;

// Windows Mobile Hotspot always hands itself this address, so pin it even when
// the hotspot is off — the certificate stays valid once it comes up.
var PINNED = ["192.168.137.1", "127.0.0.1"];

function hostIPs() {
  var out = [];
  var ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(function (name) {
    (ifs[name] || []).forEach(function (a) {
      if (a.family === "IPv4" && out.indexOf(a.address) === -1) out.push(a.address);
    });
  });
  PINNED.forEach(function (ip) { if (out.indexOf(ip) === -1) out.push(ip); });
  return out.sort();
}

// Native keygen — forge's own RSA generator is pure JS and takes seconds.
function keypair() {
  var pair = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  return {
    publicKey: forge.pki.publicKeyFromPem(pair.publicKey),
    privateKey: forge.pki.privateKeyFromPem(pair.privateKey),
    privatePem: pair.privateKey
  };
}

// A serial must be a positive integer; a leading 0 keeps the high bit clear.
function serial() {
  return "00" + crypto.randomBytes(16).toString("hex");
}

function makeCA() {
  var keys = keypair();
  var cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + CA_YEARS);

  var attrs = [
    { name: "commonName", value: "SPro Countdown Local CA" },
    { name: "organizationName", value: "SPro Countdown" }
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" }
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  return { cert: cert, keyPem: keys.privatePem };
}

function makeLeaf(ca, ips) {
  var keys = keypair();
  var cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + LEAF_DAYS * 24 * 3600 * 1000);

  cert.setSubject([{ name: "commonName", value: "SPro Countdown" }]);
  cert.setIssuer(ca.cert.subject.attributes);

  var altNames = [{ type: 2, value: "localhost" }];
  ips.forEach(function (ip) { altNames.push({ type: 7, ip: ip }); });

  cert.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: altNames }
  ]);
  cert.sign(forge.pki.privateKeyFromPem(ca.keyPem), forge.md.sha256.create());

  return { cert: cert, keyPem: keys.privatePem };
}

function loadCA() {
  if (fs.existsSync(CA_CERT) && fs.existsSync(CA_KEY)) {
    return {
      cert: forge.pki.certificateFromPem(fs.readFileSync(CA_CERT, "utf8")),
      keyPem: fs.readFileSync(CA_KEY, "utf8")
    };
  }
  var ca = makeCA();
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(CA_CERT, forge.pki.certificateToPem(ca.cert));
  fs.writeFileSync(CA_KEY, ca.keyPem);
  return ca;
}

// Returns { key, cert, ca, der, ips, freshCA } ready to hand to https.
function ensure() {
  fs.mkdirSync(DIR, { recursive: true });
  var freshCA = !fs.existsSync(CA_CERT);
  var ca = loadCA();
  var ips = hostIPs();

  var reuse = false;
  if (fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY) && fs.existsSync(TLS_META)) {
    try {
      var meta = JSON.parse(fs.readFileSync(TLS_META, "utf8"));
      var sameIPs = JSON.stringify(meta.ips) === JSON.stringify(ips);
      var stillValid = new Date(meta.notAfter).getTime() - Date.now() > 7 * 24 * 3600 * 1000;
      reuse = sameIPs && stillValid;
    } catch (e) {}
  }

  if (!reuse) {
    var leaf = makeLeaf(ca, ips);
    fs.writeFileSync(TLS_CERT, forge.pki.certificateToPem(leaf.cert));
    fs.writeFileSync(TLS_KEY, leaf.keyPem);
    fs.writeFileSync(TLS_META, JSON.stringify({
      ips: ips,
      notAfter: leaf.cert.validity.notAfter.toISOString()
    }, null, 2));
  }

  var caDer = forge.asn1.toDer(forge.pki.certificateToAsn1(ca.cert)).getBytes();

  return {
    key: fs.readFileSync(TLS_KEY),
    cert: fs.readFileSync(TLS_CERT),
    caPem: fs.readFileSync(CA_CERT),
    caDer: Buffer.from(caDer, "binary"),
    ips: ips,
    freshCA: freshCA,
    reissued: !reuse
  };
}

module.exports = { ensure: ensure, dir: DIR };
