// Builds the portable Windows .exe.
//
//   npm run dist
//
// Runs electron-builder with build-retry.js preloaded, because real-time
// antivirus on Windows makes the packaging step fail on a file lock that
// clears by itself moments later. See tools/build-retry.js.

var path = require("path");
var spawn = require("child_process").spawn;

var root = path.join(__dirname, "..");
var preload = path.join(__dirname, "build-retry.js");
var cli = require.resolve("electron-builder/out/cli/cli.js");

var args = ["--require", preload, cli].concat(process.argv.slice(2));
if (process.argv.length <= 2) args.push("--win", "portable");

var child = spawn(process.execPath, args, { stdio: "inherit", cwd: root });
child.on("exit", function (code) { process.exit(code === null ? 1 : code); });
