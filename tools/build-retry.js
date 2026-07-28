// Preloaded into the packaging process with --require.
//
// Windows real-time antivirus keeps a handle on freshly written executables
// for a second or two. Packaging writes an .exe and then immediately renames
// it, reopens it to stamp the icon in, and so on — so on a machine with active
// protection those calls fail with EPERM or EBUSY. Nothing is actually wrong:
// the identical call succeeds a few seconds later.
//
// So make the build patient rather than asking anyone to switch off their
// antivirus. Patching fs here covers every such call in the build rather than
// only the one that happens to fail first.

var fs = require("fs");
var fsp = require("fs/promises");

var TRANSIENT = ["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"];
var TRIES = 60;      // up to ~15s, far longer than a scan holds on
var DELAY = 250;

// Everything the packager aims at a file antivirus may still be holding.
var OPS = ["rename", "rm", "rmdir", "unlink", "open", "writeFile",
           "readFile", "appendFile", "copyFile", "chmod", "utimes"];

function transient(err) {
  return !!err && TRANSIENT.indexOf(err.code) !== -1;
}

function wrapPromise(target, name) {
  var orig = target[name];
  if (typeof orig !== "function") return;
  target[name] = function () {
    var args = arguments, self = this, tries = 0;
    function attempt() {
      return orig.apply(self, args).catch(function (err) {
        if (tries++ >= TRIES || !transient(err)) throw err;
        return new Promise(function (r) { setTimeout(r, DELAY); }).then(attempt);
      });
    }
    return attempt();
  };
}

function wrapCallback(name) {
  var orig = fs[name];
  if (typeof orig !== "function") return;
  fs[name] = function () {
    var args = Array.prototype.slice.call(arguments);
    var cb = args.pop();
    if (typeof cb !== "function") return orig.apply(fs, arguments);
    var tries = 0;
    function attempt() {
      orig.apply(fs, args.concat(function (err) {
        if (transient(err) && tries++ < TRIES) return setTimeout(attempt, DELAY);
        cb.apply(null, arguments);
      }));
    }
    attempt();
  };
}

function wrapSync(name) {
  var syncName = name + "Sync";
  var orig = fs[syncName];
  if (typeof orig !== "function") return;
  fs[syncName] = function () {
    for (var tries = 0; ; tries++) {
      try {
        return orig.apply(fs, arguments);
      } catch (err) {
        if (tries >= TRIES || !transient(err)) throw err;
        // Blocking wait. Only ever reached on a build machine whose antivirus
        // is in the way, so stalling this thread is exactly what we want.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, DELAY);
      }
    }
  };
}

// fs.promises and require("fs/promises") are the same object, but patch both
// names so a destructured import cannot slip past.
OPS.forEach(function (name) {
  wrapPromise(fs.promises, name);
  if (fsp !== fs.promises) wrapPromise(fsp, name);
  wrapCallback(name);
  wrapSync(name);
});
