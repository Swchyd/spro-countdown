// Relay tests.
//
// The Room Durable Object, driven over real WebSockets. Unlike the gatekeeper
// tests these need the Worker actually running, because the thing being tested
// is the socket behaviour and there is no honest way to fake that:
//
//   npx wrangler dev --port 8787 --local     # in one terminal
//   node test/relay.test.mjs                 # in another
//
// Or against the deployed one, to check a release actually took:
//
//   RELAY=wss://spro-library.<subdomain>.workers.dev/room node test/relay.test.mjs
//
// Nothing here sleeps for a fixed period waiting on the network. The first
// version did, and it passed locally and failed over the real thing — six
// hundred milliseconds is generous against a dev server on loopback and not
// always enough to reach an edge and come back. Waiting on the condition
// instead is both faster locally and honest remotely.
//
// What matters beyond the plumbing is the last two sections. A relay has no
// equivalent of the old broker refusing a taken id, so "the same device takes
// its code back" and "a different device cannot" are properties this file has
// to hold up on its own — the alternative is one church's timer appearing on
// another church's stage.
const BASE = process.env.RELAY || "ws://127.0.0.1:8787/room";
const ORIGIN = "https://swchyd.github.io";

// A fresh code per run. A fixed one collides with whatever is genuinely live on
// the Worker — a browser tab left open on the same number is refused by the
// very hijack check further down, which then reads as thirty broken tests.
const rnd = () => String(Math.floor(100000 + Math.random() * 899999));
const CODE = rnd();
const OTHER = rnd();

let pass = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fails.push(name); console.log("  FAIL  " + name + (detail ? "  (" + detail + ")" : "")); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll a condition rather than guess how long the network will take.
async function until(cond, ms = 10000) {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return true;
    if (Date.now() - t0 > ms) return false;
    await wait(50);
  }
}

const seen = (ws, t) => ws.inbox.filter((m) => m.t === t);
const last = (ws, t) => seen(ws, t).slice(-1)[0];
const send = (ws, m) => ws.send(JSON.stringify(m));

// Opens a socket and does not return until the relay has said something about
// it — a welcome, or a refusal — so no caller can send before it is connected.
async function open(code, role, dev) {
  const ws = new WebSocket(`${BASE}/${code}?role=${role}&dev=${dev}`, { headers: { Origin: ORIGIN } });
  ws.inbox = [];
  ws.closed = null;
  ws.addEventListener("message", (e) => ws.inbox.push(JSON.parse(e.data)));
  ws.addEventListener("close", (e) => { ws.closed = e.code; });
  await until(() => last(ws, "welcome") || last(ws, "taken"));
  return ws;
}

// ---------------------------------------------------------------------------
console.log("\nOne operator, two displays\n--------------------------");
const op = await open(CODE, "op", "devA");
check("the operator is welcomed", !!last(op, "welcome"), JSON.stringify(op.inbox));
check("and told it is the operator", (last(op, "welcome") || {}).role === "op");

const d1 = await open(CODE, "display", "devB");
check("a display is welcomed", !!last(d1, "welcome"));
await until(() => (last(op, "peers") || {}).n === 1);
check("the operator is told one display arrived", (last(op, "peers") || {}).n === 1,
  JSON.stringify(seen(op, "peers")));
await until(() => last(op, "need"));
check("and is asked for the full picture", !!last(op, "need"));
check("the ask carries who asked", !!(last(op, "need") || {}).from);

// Operator answers with a full snapshot.
send(op, { t: "s", d: { live: true, remainMs: 60000, songKey: "abc", song: { id: "abc", title: "Song" } } });
await until(() => (last(d1, "s") || {}).d);
check("the display receives the state", ((last(d1, "s") || {}).d || {}).remainMs === 60000);
check("including the song", !!((last(d1, "s") || {}).d || {}).song);

const d2 = await open(CODE, "display", "devC");
await until(() => (last(op, "peers") || {}).n === 2);
check("a second display is counted", (last(op, "peers") || {}).n === 2);
check("and gets the remembered state without waiting for a beat",
  !!((last(d2, "s") || {}).d || {}).song, JSON.stringify(d2.inbox));

// A lite update reaches both and does not erase the cached song.
send(op, { t: "s", d: { remainMs: 30000, songKey: "abc" } });
await until(() => ((last(d1, "s") || {}).d || {}).remainMs === 30000 &&
                  ((last(d2, "s") || {}).d || {}).remainMs === 30000);
check("a lite update reaches display one", ((last(d1, "s") || {}).d || {}).remainMs === 30000);
check("and display two", ((last(d2, "s") || {}).d || {}).remainMs === 30000);

const d3 = await open(CODE, "display", "devD");
await until(() => (last(d3, "s") || {}).d);
const cached = (last(d3, "s") || {}).d || {};
check("a late display still gets the song from the merged cache", !!cached.song, JSON.stringify(cached));
check("with the current time, not the one the song arrived with", cached.remainMs === 30000);

// ---------------------------------------------------------------------------
// Reaching the relay is not reaching the stage. A display that joins a code
// nobody is hosting gets a perfectly good socket, and if that reads as
// "connected" it stands by for ever with nothing to explain why — which is
// exactly what happened the first time this shipped.
console.log("\nA display is told whether anyone is hosting\n" +
            "------------------------------------------");
check("a display in a hosted room is told so", (last(d1, "host") || {}).on === true,
  JSON.stringify(seen(d1, "host")));

const empty = rnd();
const alone = await open(empty, "display", "devE");
await until(() => last(alone, "host"));
check("a display in an empty room is told there is nobody", (last(alone, "host") || {}).on === false,
  JSON.stringify(alone.inbox));

const late = await open(empty, "op", "devF");
await until(() => (last(alone, "host") || {}).on === true);
check("and hears about it the moment an operator opens the room",
  (last(alone, "host") || {}).on === true, JSON.stringify(seen(alone, "host")));

late.close();
await until(() => (last(alone, "host") || {}).on === false);
check("and hears about it again when the operator walks out",
  (last(alone, "host") || {}).on === false, JSON.stringify(seen(alone, "host")));
alone.close();

// ---------------------------------------------------------------------------
console.log("\nClock sync is routed back to the display that asked\n" +
            "--------------------------------------------------");
send(d1, { t: "ping", c: 1111 });
await until(() => last(op, "ping"));
const ping = last(op, "ping") || {};
check("the operator receives the ping", ping.c === 1111);
send(op, { t: "pong", c: ping.c, s: 999, to: ping.from });
await until(() => last(d1, "pong"));
check("the pong reaches the display that pinged", (last(d1, "pong") || {}).s === 999);
check("and nobody else", !last(d2, "pong"));

// ---------------------------------------------------------------------------
console.log("\nA display leaving is counted\n----------------------------");
d3.close();
await until(() => (last(op, "peers") || {}).n === 2);
check("the operator's count comes back down", (last(op, "peers") || {}).n === 2,
  JSON.stringify(seen(op, "peers").slice(-3)));

// ---------------------------------------------------------------------------
console.log("\nRoom codes cannot be hijacked\n-----------------------------");
const intruder = await open(CODE, "op", "devZ");
check("another device is refused the code", !!last(intruder, "taken"));
// The refusal has to be more than a message: a client that ignores it must not
// be able to drive anybody's stage.
try {
  send(intruder, { t: "s", d: { remainMs: 999999, songKey: "hijack", song: { id: "x", title: "Hijacked" } } });
} catch {
  // Already hung up on. That is the refusal working, not a failure.
}
send(op, { t: "s", d: { remainMs: 12345, songKey: "abc" } });
await until(() => ((last(d1, "s") || {}).d || {}).remainMs === 12345);
check("a refused operator cannot push state",
  seen(d1, "s").every((m) => m.d.remainMs !== 999999),
  JSON.stringify(seen(d1, "s").map((m) => m.d.remainMs)));
check("the real operator is left alone", op.readyState === 1 && !last(op, "replaced"));
check("and still reaches its displays", ((last(d1, "s") || {}).d || {}).remainMs === 12345);

// ---------------------------------------------------------------------------
console.log("\nThe same device reclaims its own code\n-------------------------------------");
const again = await open(CODE, "op", "devA");
check("the same device is welcomed", !!last(again, "welcome"));
await until(() => last(op, "replaced"));
check("the stale socket is told it was replaced", !!last(op, "replaced"));
await until(() => op.closed !== null);
check("and closed", op.closed === 4000, "close code " + op.closed);
await until(() => (last(again, "peers") || {}).n === 2);
check("the displays are still there", (last(again, "peers") || {}).n === 2,
  JSON.stringify(seen(again, "peers")));
send(again, { t: "s", d: { remainMs: 777, songKey: "abc" } });
await until(() => ((last(d1, "s") || {}).d || {}).remainMs === 777);
check("the reclaimed room drives the stage again", ((last(d1, "s") || {}).d || {}).remainMs === 777);

// ---------------------------------------------------------------------------
console.log("\nRooms are separate\n------------------");
const other = await open(OTHER, "op", "devQ");
check("a different code gets its own operator slot", !!last(other, "welcome"));
send(other, { t: "s", d: { remainMs: 5, songKey: "zzz" } });
await wait(500);
check("and its state does not leak into the first room",
  ((last(d1, "s") || {}).d || {}).remainMs === 777);

for (const ws of [again, d1, d2, other, intruder]) { try { ws.close(); } catch {} }
await wait(300);

console.log("\n" + "=".repeat(50));
console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) { fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
