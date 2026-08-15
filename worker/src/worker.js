// SPro Countdown — song library gatekeeper
//
// The library itself is still songs.json in the public repo, and reading it is
// still a plain unauthenticated fetch. What changed is writing: the GitHub
// token used to sit in the operator's localStorage, which meant every device
// that could write could write *anything* — GitHub cannot tell "edit one song"
// from "replace the file with []". Both are the same PUT.
//
// So the token moved here, where no browser can reach it, and the browser now
// sends operations instead of files. This Worker is the only thing that turns
// an operation into a commit, which is what makes a rule like "a collaborator
// may not delete 400 songs" enforceable rather than merely displayed.
//
// Three layers, and each one has to agree before anything is written:
//
//   identity     a session token issued in exchange for the access code
//   role         owner / collaborator / viewer, stored server-side
//   blast radius how many records this operation actually touches
//
// The last one is the point. Roles stop the wrong person; the blast-radius
// check stops the right person having a bad day.

const VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Policy
//
// Defaults, overridable per-install by writing a `config` key in KV. They are
// deliberately in one place: "don't hard-code arbitrary thresholds" means the
// numbers have to be findable and changeable, not that they can't exist.
// ---------------------------------------------------------------------------
const DEFAULT_POLICY = {
  // Deleted songs stay recoverable this long before purge is even offered.
  retentionDays: 30,

  // Most songs one operation may soft-delete, per role. A collaborator tidying
  // up removes a handful; nobody legitimately removes 30 in one gesture.
  collaboratorBulkMax: 25,
  ownerBulkMax: 500,

  // The rule that actually protects the 1,000-song case: no single operation
  // may remove more than this share of the live library, whoever asks.
  maxFractionPerOp: 0.30,

  // ...except when the library is small, where "30%" is three songs and the
  // rule would just be in the way.
  fractionFloor: 20,

  // Above this many records, the client must echo back a phrase that the
  // server computes from the true affected count.
  confirmAbove: 10,

  // Restoring is how a collaborator undoes their own mistake, so it is on by
  // default. Owners who want restore to be their call alone can turn it off.
  collaboratorsCanRestore: true,

  // Sessions are long-lived because the people using this are on stage, not at
  // a desk — but not unlimited, so an abandoned iPad eventually stops counting.
  sessionDays: 60
};

const ROLES = ["owner", "collaborator", "viewer"];

// What each role may ask for. Checked on every request before the operation is
// even parsed, so an unknown action fails closed.
const CAN = {
  "song.create": ["owner", "collaborator"],
  "song.update": ["owner", "collaborator"],
  "song.delete": ["owner", "collaborator"],
  "song.restore": ["owner", "collaborator"],
  "setlist.set": ["owner", "collaborator"],
  "song.purge": ["owner"],
  "trash.empty": ["owner"],
  "admin": ["owner"]
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }
}

const enc = new TextEncoder();

function b64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Standard base64, for the PBKDF2 salt — `derive` reads it back with atob, so
// it has to survive the round trip unaltered.
function b64std(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

// Ids travel in URL paths, so they are hex rather than base64url: base64url
// emits "-", the route patterns did not accept it, and the result was that
// roughly a third of collaborators drew an id their own owner could not revoke.
// Hex has no such surprises and costs a few characters nobody reads anyway.
function randomId(prefix, bytes) {
  return (
    prefix +
    [...randomBytes(bytes || 9)].map((b) => b.toString(16).padStart(2, "0")).join("")
  );
}

async function sha256Hex(str) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(str));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Compares without leaking where the first difference was. Both arguments are
// hex digests of the same length, so no length-based early exit is needed.
function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// PBKDF2 rather than a bare hash: the access code is short enough to type on an
// iPad, which means it is short enough to guess offline if the hash ever leaks.
//
// 100000 is not a preference — it is the ceiling Workers enforces, and asking
// for more throws rather than clamping. That is comfortable here anyway: the
// iteration count is what buys time against a *low-entropy* secret, and the
// code this protects is 60 bits of uniform randomness. Guessing it is out of
// reach at any iteration count; the stretching is insurance against the code
// ever being replaced by something a human chose.
//
// Changing this number invalidates every stored code, since the digest would no
// longer match. Regenerating the access code is the migration.
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_MAX_ON_WORKERS = 100000;

async function derive(code, saltB64) {
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", enc.encode(code), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Crockford-ish: no I, L, O, U, so nothing gets misread off a phone screen or
// misheard down a phone line.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function generateCode() {
  const bytes = randomBytes(12);
  let out = "";
  for (let i = 0; i < 12; i++) {
    if (i && i % 4 === 0) out += "-";
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out; // XXXX-XXXX-XXXX — 60 bits
}

function normalizeCode(input) {
  return String(input || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
}

function now() {
  return Date.now();
}

// ---------------------------------------------------------------------------
// CORS
//
// The app is served from three places that are all legitimate: GitHub Pages,
// the operator's own machine, and the LAN server the iPad connects to during a
// service. The LAN address changes with the venue, so private ranges are
// matched by shape rather than listed.
// ---------------------------------------------------------------------------
const PRIVATE_HOST =
  /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;

function originAllowed(origin, env) {
  if (!origin) return false;
  const extra = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (extra.includes(origin)) return true;
  let u;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.origin === "https://swchyd.github.io") return true;
  if ((u.protocol === "http:" || u.protocol === "https:") && PRIVATE_HOST.test(u.hostname)) return true;
  return false;
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const h = {
    "Vary": "Origin",
    // PUT belongs here as much as the rest: /setlist takes it and nothing else.
    // Leaving it out cost nothing on the read side and everything on the write
    // side — the preflight answered 204, so the client saw no server error at
    // all, just a fetch that never left the browser, and a queued setlist that
    // retried forever without once reaching here.
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400"
  };
  if (originAllowed(origin, env)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function json(body, status, request, env) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(request, env)
    }
  });
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

async function getConfig(env) {
  const raw = await env.SPRO.get("config", "json");
  const cfg = raw || {};
  return {
    codeHash: cfg.codeHash || null,
    codeSalt: cfg.codeSalt || null,
    codeVersion: cfg.codeVersion || 0,
    codeCreatedAt: cfg.codeCreatedAt || 0,
    codeExpiresAt: cfg.codeExpiresAt || 0, // 0 = no expiry
    codeRevoked: !!cfg.codeRevoked,
    defaultRole: ROLES.includes(cfg.defaultRole) ? cfg.defaultRole : "collaborator",
    // Whether rotating the code also ends every existing session. Documented
    // behaviour, not a guess — see the README.
    rotateEndsSessions: cfg.rotateEndsSessions !== false,
    policy: { ...DEFAULT_POLICY, ...(cfg.policy || {}) }
  };
}

async function putConfig(env, cfg) {
  await env.SPRO.put("config", JSON.stringify(cfg));
}

// ---------------------------------------------------------------------------
// Rate limiting
//
// KV is eventually consistent, so this is a speed bump rather than a hard gate
// under a distributed attack. It does not carry the weight on its own: a 60-bit
// code behind 210k PBKDF2 iterations is not guessable regardless. What this
// buys is that a person mistyping the code, or a script trying the obvious
// ones, stops early and visibly.
// ---------------------------------------------------------------------------
const RL_WINDOW_MS = 15 * 60 * 1000;
const RL_MAX_FAILURES = 8;

// The whole-service counter exists only to blunt an attack spread across many
// addresses, and it has to sit far above the per-address limit: if one person
// mistyping the code could trip a shared counter, the way to lock a church out
// of its own library on a Sunday morning would be to guess wrong nine times.
const RL_GLOBAL_MAX_FAILURES = 400;

async function rateLimitCheck(env, bucket) {
  const key = "rl:" + bucket;
  const rec = await env.SPRO.get(key, "json");
  if (!rec) return;
  if (rec.lockedUntil && rec.lockedUntil > now()) {
    const secs = Math.ceil((rec.lockedUntil - now()) / 1000);
    throw new HttpError(429, "rate_limited", `Too many attempts. Try again in ${secs}s.`, { retryAfter: secs });
  }
}

async function rateLimitFail(env, bucket, max) {
  const key = "rl:" + bucket;
  const limit = max || RL_MAX_FAILURES;
  const rec = (await env.SPRO.get(key, "json")) || { n: 0, first: now(), lockedUntil: 0 };
  if (now() - rec.first > RL_WINDOW_MS) {
    rec.n = 0;
    rec.first = now();
  }
  rec.n += 1;
  if (rec.n >= limit) {
    // Each further burst locks for longer, so a script gives up before a human
    // who fat-fingered it twice is meaningfully inconvenienced.
    const overshoot = rec.n - limit;
    rec.lockedUntil = now() + RL_WINDOW_MS * Math.min(8, 1 + overshoot);
  }
  await env.SPRO.put(key, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 });
}

async function rateLimitClear(env, bucket) {
  await env.SPRO.delete("rl:" + bucket);
}

// ---------------------------------------------------------------------------
// Sessions
//
// The access code proves someone was told the code. It cannot prove *who* they
// are — so joining mints a per-person session with its own id, and everything
// after that is attributed to and revocable at that id. Revoking one person
// does not disturb anyone else, which an access code alone could never do.
// ---------------------------------------------------------------------------

async function createSession(env, cfg, name, role) {
  // The token never appears in a URL, only in a header, so base64url is fine
  // there — it is the id that has to survive being pasted into a path.
  const token = b64url(randomBytes(32));
  const id = randomId("c_", 9);
  const rec = {
    id,
    name: String(name || "").trim().slice(0, 40) || "Someone",
    role,
    joinedAt: now(),
    lastSeenAt: now(),
    codeVersion: cfg.codeVersion,
    revoked: false
  };
  const ttl = cfg.policy.sessionDays * 24 * 60 * 60;
  // The token is never stored — only its digest, so a dump of KV does not hand
  // anyone a working session.
  await env.SPRO.put("sess:" + (await sha256Hex(token)), JSON.stringify(rec), { expirationTtl: ttl });
  await env.SPRO.put("collab:" + id, JSON.stringify(rec), { expirationTtl: ttl });
  return { token, rec };
}

async function authenticate(request, env) {
  const header = request.headers.get("Authorization") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new HttpError(401, "no_session", "Sign in first.");
  const key = "sess:" + (await sha256Hex(m[1].trim()));
  const sess = await env.SPRO.get(key, "json");
  if (!sess) throw new HttpError(401, "no_session", "Session expired. Sign in again.");
  if (sess.revoked) throw new HttpError(403, "revoked", "This access has been revoked.");

  const cfg = await getConfig(env);

  // Struck dead when the code was regenerated or revoked (see endCodeSessions).
  // Unconditional, and ahead of the version comparison below: once an owner has
  // put someone out, no later change of configuration may let them back in on
  // the same token.
  if (sess.codeEnded) {
    throw new HttpError(403, "code_rotated",
      sess.codeEndedReason === "access code revoked"
        ? "The access code was revoked. Ask the owner for a new one."
        : "The access code was changed. Ask the owner for the new one.");
  }

  // The same conclusion reached by comparison, which is what catches a session
  // issued before this build — and any that slipped past a sweep.
  //
  // Owner sessions ride on the owner key, not the access code, so rotating the
  // code must never lock the owner out of their own library.
  if (sess.role !== "owner" && cfg.rotateEndsSessions && sess.codeVersion !== cfg.codeVersion) {
    throw new HttpError(403, "code_rotated", "The access code was changed. Ask the owner for the new one.");
  }

  // The collaborator record is the one the owner sees; keep it current without
  // writing on every single request.
  const mirror = await env.SPRO.get("collab:" + sess.id, "json");
  if (mirror && (!mirror.lastSeenAt || now() - mirror.lastSeenAt > 5 * 60 * 1000)) {
    mirror.lastSeenAt = now();
    await env.SPRO.put("collab:" + sess.id, JSON.stringify(mirror), {
      expirationTtl: cfg.policy.sessionDays * 24 * 60 * 60
    });
  }
  // Role lives on the collaborator record so an owner's change takes effect on
  // the next request rather than the next sign-in.
  if (mirror) {
    if (mirror.revoked) throw new HttpError(403, "revoked", "This access has been revoked.");
    sess.role = mirror.role;
    sess.name = mirror.name;
  }

  return { actor: sess, cfg };
}

function requireRole(actor, action) {
  const allowed = CAN[action];
  if (!allowed || !allowed.includes(actor.role)) {
    throw new HttpError(403, "forbidden", `Your role (${actor.role}) cannot do that.`);
  }
}

// ---------------------------------------------------------------------------
// The library, as GitHub holds it
// ---------------------------------------------------------------------------

function ghHeaders(env) {
  return {
    "Authorization": "Bearer " + env.GITHUB_TOKEN,
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "spro-countdown-gatekeeper"
  };
}

function ghContentsUrl(env) {
  const owner = env.GH_OWNER || "Swchyd";
  const repo = env.GH_REPO || "spro-countdown";
  const file = env.GH_FILE || "songs.json";
  return `https://api.github.com/repos/${owner}/${repo}/contents/${file}`;
}

function utf8ToB64(str) {
  const bytes = enc.encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// v1 files have `hidden` and no per-song version. Both are filled in on read so
// the rest of the Worker never has to think about which era a song came from,
// and `hidden` keeps being written so clients still on the old build carry on
// working.
function normalizeLibrary(raw) {
  const lib = raw && typeof raw === "object" ? raw : {};
  const songs = Array.isArray(lib.songs) ? lib.songs : [];
  for (const s of songs) {
    if (!s || typeof s !== "object") continue;
    if (typeof s.version !== "number") s.version = 1;
    if (s.hidden && !s.deletedAt) {
      s.deletedAt = s.updatedAt || now();
      if (!s.deletedBy) s.deletedBy = "(before activity logging)";
    }
    if (!s.hidden && s.deletedAt) s.hidden = true;
    if (!s.deletedAt) {
      s.hidden = false;
      delete s.deletedAt;
      delete s.deletedBy;
    }
  }
  return {
    v: 2,
    songs,
    setlist: Array.isArray(lib.setlist) ? lib.setlist : [],
    setlistAt: lib.setlistAt || 0,
    setlistBy: lib.setlistBy || ""
  };
}

async function readLibrary(env) {
  const r = await fetch(ghContentsUrl(env) + "?ref=" + (env.GH_BRANCH || "main") + "&t=" + now(), {
    headers: ghHeaders(env),
    cf: { cacheTtl: 0 }
  });
  if (r.status === 404) return { sha: null, lib: normalizeLibrary(null) };
  if (r.status === 401) throw new HttpError(502, "github_auth", "The server's GitHub token was rejected.");
  if (!r.ok) throw new HttpError(502, "github_read", `Could not read the library (${r.status}).`);
  const d = await r.json();
  let parsed = null;
  try {
    parsed = JSON.parse(b64ToUtf8(d.content));
  } catch {
    throw new HttpError(502, "corrupt", "The stored library is not valid JSON. Restore it from git history.");
  }
  return { sha: d.sha, lib: normalizeLibrary(parsed) };
}

async function writeLibrary(env, lib, sha, message, actor) {
  const body = {
    message,
    content: utf8ToB64(JSON.stringify(lib, null, 1)),
    branch: env.GH_BRANCH || "main",
    // Attribution in git itself, so the commit log is a second, independent
    // record of who did what — one this Worker cannot rewrite.
    author: { name: actor.name || "SPro", email: `${actor.id || "system"}@spro.invalid` }
  };
  if (sha) body.sha = sha;
  const r = await fetch(ghContentsUrl(env), {
    method: "PUT",
    headers: ghHeaders(env),
    body: JSON.stringify(body)
  });
  if (r.ok) return true;
  if (r.status === 409 || r.status === 422) return false; // someone wrote first
  if (r.status === 403) throw new HttpError(502, "github_perm", "The server's GitHub token cannot write to the repo.");
  throw new HttpError(502, "github_write", `Could not save the library (${r.status}).`);
}

// Read, apply, write, and if someone slipped in between, do the whole thing
// again against their result. The mutation is a function rather than a diff so
// that retrying re-decides — a bulk delete that was under the threshold before
// a concurrent write may be over it afterwards, and it should be re-checked,
// not replayed.
async function mutate(env, actor, apply) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { sha, lib } = await readLibrary(env);
    const outcome = apply(lib);
    if (!outcome || outcome.noop) return outcome || { noop: true };
    const ok = await writeLibrary(env, lib, sha, outcome.message, actor);
    if (ok) return outcome;
  }
  throw new HttpError(
    409,
    "busy",
    "The library is being changed by someone else right now. Try again in a moment."
  );
}

// ---------------------------------------------------------------------------
// Audit log
//
// Append-only by construction: nothing in this file deletes or edits an audit
// key, and no route exposes one. Keys sort newest-first so a read is one
// bounded list, not a scan.
// ---------------------------------------------------------------------------
const AUDIT_MAX_TS = 10000000000000;

async function audit(env, actor, action, entry) {
  const ts = now();
  const key = `audit:${String(AUDIT_MAX_TS - ts).padStart(14, "0")}:${b64url(randomBytes(4))}`;
  const rec = {
    at: ts,
    user: actor.name || "?",
    userId: actor.id || "?",
    role: actor.role,
    action,
    ...entry
  };
  await env.SPRO.put(key, JSON.stringify(rec));
  return rec;
}

// Lyrics are long and the interesting part of an edit is which fields moved,
// so values are summarised rather than stored whole. The full previous text is
// always one `git show` away.
function summarizeValue(v) {
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? "" : "s"}`;
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 160 ? s.slice(0, 157) + "…" : s;
}

function diffSong(before, after) {
  const fields = ["title", "author", "slides", "tags", "notes", "perSlide", "order", "sections"];
  const changes = [];
  for (const f of fields) {
    const a = JSON.stringify(before ? before[f] : undefined);
    const b = JSON.stringify(after ? after[f] : undefined);
    if (a !== b) {
      changes.push({
        field: f,
        from: summarizeValue(before ? before[f] : undefined),
        to: summarizeValue(after ? after[f] : undefined)
      });
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Blast-radius checks
//
// Called by every path that removes anything. `count` is always recomputed
// from what the operation will actually touch, never taken from the client —
// which is also what makes the typed phrase meaningful, since the phrase is
// built from the server's count.
// ---------------------------------------------------------------------------
function expectedPhrase(kind, count) {
  if (kind === "purge") return "DELETE FOREVER";
  if (kind === "empty") return `EMPTY TRASH ${count}`;
  return `DELETE ${count} SONGS`;
}

function guardRemoval(cfg, actor, kind, count, liveCount, confirm) {
  const p = cfg.policy;
  if (count === 0) return;

  const perOpMax = actor.role === "owner" ? p.ownerBulkMax : p.collaboratorBulkMax;
  if (count > perOpMax) {
    throw new HttpError(
      403,
      "too_many",
      `That would affect ${count} songs; ${actor.role === "owner" ? "an owner" : "a collaborator"} may affect ` +
        `${perOpMax} in one operation. Do it in smaller batches.`,
      { count, limit: perOpMax }
    );
  }

  // The share rule. This is what stands between "select all" and an empty
  // library, and it applies to the owner too — an owner's slip is still a slip.
  //
  // Only for soft deletes: what it protects is the *live* library, and purging
  // or emptying the trash does not touch that. Those two are held back by being
  // owner-only, phrase-confirmed, and reachable only for songs that have
  // already sat in the trash for the retention period.
  if (kind === "delete" && liveCount >= p.fractionFloor) {
    const maxByFraction = Math.floor(liveCount * p.maxFractionPerOp);
    if (count > maxByFraction) {
      throw new HttpError(
        403,
        "too_broad",
        `That would remove ${count} of ${liveCount} songs in one go. The limit is ` +
          `${maxByFraction} (${Math.round(p.maxFractionPerOp * 100)}% of the library). ` +
          `Do it in smaller batches.`,
        { count, liveCount, limit: maxByFraction }
      );
    }
  }

  if (count > p.confirmAbove || kind === "purge" || kind === "empty") {
    const want = expectedPhrase(kind, count);
    if (String(confirm || "").trim().toUpperCase() !== want) {
      throw new HttpError(428, "confirm_required", `Type "${want}" to confirm.`, { phrase: want, count });
    }
  }
}

function liveSongs(lib) {
  return lib.songs.filter((s) => s && !s.deletedAt);
}

function findSong(lib, id) {
  return lib.songs.find((s) => s && s.id === id) || null;
}

// ---------------------------------------------------------------------------
// Idempotency
//
// The client queues operations while offline and flushes them on reconnect, so
// a retry after a dropped response must not add the same song twice.
// ---------------------------------------------------------------------------
async function replayed(env, opId) {
  if (!opId) return null;
  return await env.SPRO.get("idem:" + opId, "json");
}

async function remember(env, opId, payload) {
  if (!opId) return;
  await env.SPRO.put("idem:" + opId, JSON.stringify(payload), { expirationTtl: 60 * 60 * 24 * 2 });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handleJoin(request, env) {
  const body = await request.json().catch(() => ({}));
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const bucket = "ip:" + ip;

  await rateLimitCheck(env, bucket);
  await rateLimitCheck(env, "global");

  const cfg = await getConfig(env);
  if (!cfg.codeHash || cfg.codeRevoked) {
    throw new HttpError(403, "no_code", "There is no active access code. Ask the owner to generate one.");
  }
  if (cfg.codeExpiresAt && cfg.codeExpiresAt < now()) {
    throw new HttpError(403, "code_expired", "That access code has expired.");
  }

  const supplied = normalizeCode(body.code);
  if (!supplied) throw new HttpError(400, "bad_request", "Enter the access code.");

  const hash = await derive(supplied, cfg.codeSalt);
  if (!constantTimeEqual(hash, cfg.codeHash)) {
    await rateLimitFail(env, bucket);
    await rateLimitFail(env, "global", RL_GLOBAL_MAX_FAILURES);
    // Deliberately identical to every other wrong-code outcome: saying "close,
    // but expired" tells an attacker they found a real code.
    throw new HttpError(403, "bad_code", "That access code is not valid.");
  }

  await rateLimitClear(env, bucket);
  const { token, rec } = await createSession(env, cfg, body.name, cfg.defaultRole);
  await audit(env, rec, "member.join", { note: `${rec.name} joined as ${rec.role}` });

  return { token, me: { id: rec.id, name: rec.name, role: rec.role, joinedAt: rec.joinedAt } };
}

async function handleOwnerSignIn(request, env) {
  const body = await request.json().catch(() => ({}));
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const bucket = "owner:" + ip;

  await rateLimitCheck(env, bucket);
  if (!env.OWNER_KEY) throw new HttpError(500, "not_configured", "No owner key is configured on the server.");

  // Trimmed on both sides. A key that arrives with a trailing space from a
  // paste is not a different key, and an invisible difference is a miserable
  // thing to debug from a message that can only ever say "not valid".
  const supplied = String(body.key || "").trim();
  const stored = String(env.OWNER_KEY || "").trim();
  // Hash both sides so the comparison is over fixed-length strings.
  const ok = constantTimeEqual(await sha256Hex(supplied), await sha256Hex(stored));
  if (!ok) {
    await rateLimitFail(env, bucket);
    throw new HttpError(403, "bad_key", "That owner key is not valid.");
  }
  await rateLimitClear(env, bucket);

  const cfg = await getConfig(env);
  const { token, rec } = await createSession(env, cfg, body.name || "Owner", "owner");
  await audit(env, rec, "owner.signin", { note: `${rec.name} signed in as owner` });
  return { token, me: { id: rec.id, name: rec.name, role: rec.role, joinedAt: rec.joinedAt } };
}

async function handleCreate(request, env, actor, cfg) {
  requireRole(actor, "song.create");
  const body = await request.json().catch(() => ({}));
  const cached = await replayed(env, body.opId);
  if (cached) return cached;

  const song = body.song || {};
  if (!song.title && !(Array.isArray(song.slides) && song.slides.length)) {
    throw new HttpError(400, "bad_request", "A song needs a title or some words.");
  }

  // The client generates the id so that a song written offline already has one
  // the moment it is typed. A malformed one is refused rather than replaced:
  // quietly handing back a different id would leave the client editing a song
  // that, as far as the server is concerned, does not exist.
  let id;
  if (song.id === undefined || song.id === null || song.id === "") {
    id = "s_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  } else if (typeof song.id === "string" && /^s_[A-Za-z0-9_]{2,40}$/.test(song.id)) {
    id = song.id;
  } else {
    throw new HttpError(400, "bad_id", "That song id is not in a form this library accepts.");
  }

  let created = null;
  const outcome = await mutate(env, actor, (lib) => {
    if (findSong(lib, id)) {
      // The client generated this id, so a collision means this is a replay
      // whose response was lost rather than a genuine second song.
      created = findSong(lib, id);
      return { noop: true };
    }
    created = {
      id,
      title: String(song.title || "Untitled").slice(0, 200),
      author: String(song.author || "").slice(0, 200),
      sections: song.sections || [],
      order: song.order || [],
      slides: song.slides || [],
      tags: song.tags || [],
      notes: song.notes || [],
      perSlide: song.perSlide || 4,
      version: 1,
      updatedAt: now(),
      updatedBy: actor.name,
      lastUsed: 0,
      hidden: false
    };
    lib.songs.push(created);
    return { message: `${actor.name} added "${created.title}"` };
  });

  if (!outcome.noop) {
    await audit(env, actor, "song.create", { songId: id, title: created.title });
  }
  const result = { song: created };
  await remember(env, body.opId, result);
  return result;
}

async function handleUpdate(request, env, actor, cfg, id) {
  requireRole(actor, "song.update");
  const body = await request.json().catch(() => ({}));
  const cached = await replayed(env, body.opId);
  if (cached) return cached;

  const patch = body.song || {};
  let updated = null;
  let changes = [];

  await mutate(env, actor, (lib) => {
    const s = findSong(lib, id);
    if (!s) throw new HttpError(404, "not_found", "That song is not in the library.");

    // Optimistic concurrency. The client sends the version it was looking at;
    // if the stored one has moved on, somebody else saved in the meantime and
    // this write would erase their work without either of them noticing.
    if (typeof body.baseVersion === "number" && body.baseVersion !== s.version) {
      throw new HttpError(409, "conflict", `"${s.title}" was changed by ${s.updatedBy || "someone else"} while you were editing.`, {
        theirs: s,
        yourBaseVersion: body.baseVersion,
        currentVersion: s.version
      });
    }

    const before = JSON.parse(JSON.stringify(s));
    for (const f of ["title", "author", "sections", "order", "slides", "tags", "notes", "perSlide"]) {
      if (f in patch) s[f] = patch[f];
    }
    changes = diffSong(before, s);
    if (!changes.length) {
      updated = s;
      return { noop: true };
    }
    // Editing a song is also how it comes back from the trash, matching the
    // old behaviour where saving cleared `hidden`.
    if (s.deletedAt && body.undelete) {
      delete s.deletedAt;
      delete s.deletedBy;
      s.hidden = false;
    }
    s.version = (s.version || 1) + 1;
    s.updatedAt = now();
    s.updatedBy = actor.name;
    updated = s;
    return { message: `${actor.name} edited "${s.title}"` };
  });

  if (changes.length) {
    await audit(env, actor, "song.update", { songId: id, title: updated.title, changes });
  }
  const result = { song: updated };
  await remember(env, body.opId, result);
  return result;
}

// One route for one song and for many, because they are the same operation and
// splitting them is exactly how a "bulk" path ends up without the checks the
// single path has.
async function handleDelete(request, env, actor, cfg, explicitId) {
  requireRole(actor, "song.delete");
  const body = await request.json().catch(() => ({}));
  const cached = await replayed(env, body.opId);
  if (cached) return cached;

  const ids = explicitId ? [explicitId] : Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length) throw new HttpError(400, "bad_request", "No songs given.");

  let affected = [];
  await mutate(env, actor, (lib) => {
    const live = liveSongs(lib);
    const targets = ids.map((i) => findSong(lib, i)).filter((s) => s && !s.deletedAt);
    guardRemoval(cfg, actor, "delete", targets.length, live.length, body.confirm);
    if (!targets.length) return { noop: true };

    for (const s of targets) {
      s.deletedAt = now();
      s.deletedBy = actor.name;
      s.hidden = true; // still written, so older clients keep hiding it too
      s.version = (s.version || 1) + 1;
      s.updatedAt = now();
      s.updatedBy = actor.name;
    }
    // The setlist points at songs; a deleted song must not linger in tonight's
    // running order as a blank row.
    const gone = new Set(targets.map((s) => s.id));
    const before = lib.setlist.length;
    lib.setlist = lib.setlist.filter((e) => !gone.has(e.id));
    if (lib.setlist.length !== before) lib.setlistAt = now();

    affected = targets.map((s) => ({ id: s.id, title: s.title }));
    return {
      message:
        targets.length === 1
          ? `${actor.name} deleted "${targets[0].title}"`
          : `${actor.name} deleted ${targets.length} songs`
    };
  });

  for (const a of affected) {
    await audit(env, actor, "song.delete", { songId: a.id, title: a.title });
  }
  const result = { deleted: affected.length, songs: affected };
  await remember(env, body.opId, result);
  return result;
}

async function handleRestore(request, env, actor, cfg, explicitId) {
  requireRole(actor, "song.restore");
  if (actor.role !== "owner" && !cfg.policy.collaboratorsCanRestore) {
    throw new HttpError(403, "forbidden", "Only the owner can restore songs in this library.");
  }
  const body = await request.json().catch(() => ({}));
  const cached = await replayed(env, body.opId);
  if (cached) return cached;

  const ids = explicitId ? [explicitId] : Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length) throw new HttpError(400, "bad_request", "No songs given.");

  let affected = [];
  await mutate(env, actor, (lib) => {
    const targets = ids.map((i) => findSong(lib, i)).filter((s) => s && s.deletedAt);
    if (!targets.length) return { noop: true };
    for (const s of targets) {
      delete s.deletedAt;
      delete s.deletedBy;
      s.hidden = false;
      s.version = (s.version || 1) + 1;
      s.updatedAt = now();
      s.updatedBy = actor.name;
    }
    affected = targets.map((s) => ({ id: s.id, title: s.title }));
    return {
      message:
        targets.length === 1
          ? `${actor.name} restored "${targets[0].title}"`
          : `${actor.name} restored ${targets.length} songs`
    };
  });

  for (const a of affected) {
    await audit(env, actor, "song.restore", { songId: a.id, title: a.title });
  }
  const result = { restored: affected.length, songs: affected };
  await remember(env, body.opId, result);
  return result;
}

// The only path that actually removes a record. Owner-only, phrase-confirmed,
// and it will not touch anything that is not already in the trash — so there is
// no way to reach it from a normal delete, however the request is shaped.
async function handlePurge(request, env, actor, cfg, explicitId) {
  requireRole(actor, "song.purge");
  const body = await request.json().catch(() => ({}));
  const ids = explicitId ? [explicitId] : Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length) throw new HttpError(400, "bad_request", "No songs given.");

  let affected = [];
  await mutate(env, actor, (lib) => {
    const targets = ids.map((i) => findSong(lib, i)).filter((s) => s && s.deletedAt);
    if (!targets.length) {
      throw new HttpError(400, "not_deleted", "A song has to be in Recently Deleted before it can be removed for good.");
    }
    guardRemoval(cfg, actor, "purge", targets.length, liveSongs(lib).length, body.confirm);
    const gone = new Set(targets.map((s) => s.id));
    affected = targets.map((s) => ({ id: s.id, title: s.title }));
    lib.songs = lib.songs.filter((s) => !gone.has(s.id));
    return { message: `${actor.name} permanently deleted ${affected.length} song(s)` };
  });

  for (const a of affected) {
    await audit(env, actor, "song.purge", { songId: a.id, title: a.title, note: "permanent" });
  }
  return { purged: affected.length, songs: affected };
}

async function handleEmptyTrash(request, env, actor, cfg) {
  requireRole(actor, "trash.empty");
  const body = await request.json().catch(() => ({}));
  const olderThanDays =
    typeof body.olderThanDays === "number" ? body.olderThanDays : cfg.policy.retentionDays;
  const cutoff = now() - olderThanDays * 24 * 60 * 60 * 1000;

  let affected = [];
  await mutate(env, actor, (lib) => {
    // Retention is enforced here, not in the UI: songs deleted yesterday are
    // simply not eligible, so "empty trash" cannot undo a recent mistake.
    const targets = lib.songs.filter((s) => s.deletedAt && s.deletedAt < cutoff);
    if (!targets.length) return { noop: true };
    guardRemoval(cfg, actor, "empty", targets.length, liveSongs(lib).length, body.confirm);
    const gone = new Set(targets.map((s) => s.id));
    affected = targets.map((s) => ({ id: s.id, title: s.title }));
    lib.songs = lib.songs.filter((s) => !gone.has(s.id));
    return { message: `${actor.name} emptied the trash (${affected.length} songs)` };
  });

  for (const a of affected) {
    await audit(env, actor, "trash.empty", { songId: a.id, title: a.title, note: "permanent" });
  }
  return { purged: affected.length, songs: affected, olderThanDays };
}

async function handleSetlist(request, env, actor, cfg) {
  requireRole(actor, "setlist.set");
  const body = await request.json().catch(() => ({}));
  const entries = Array.isArray(body.setlist) ? body.setlist : [];
  if (entries.length > 300) throw new HttpError(400, "bad_request", "That setlist is implausibly long.");

  await mutate(env, actor, (lib) => {
    const clean = entries
      .filter((e) => e && typeof e.id === "string" && findSong(lib, e.id))
      .map((e) => ({ id: e.id, ms: Number(e.ms) || 0 }));
    if (JSON.stringify(clean) === JSON.stringify(lib.setlist)) return { noop: true };
    lib.setlist = clean;
    lib.setlistAt = now();
    lib.setlistBy = actor.name;
    return { message: `${actor.name} updated the setlist` };
  });
  return { ok: true };
}

// --- owner-only administration --------------------------------------------

// Turning everyone but the owner out of the building.
//
// authenticate() already refuses a session whose codeVersion has fallen behind,
// so the old code stopped opening doors the moment it was replaced. That is not
// the same as being out, and the difference showed in two places the owner
// actually looks. The collaborator list still read "active" for every one of
// them, because nothing had touched those records — so the person who had just
// regenerated the code to get someone out had no way to see that it worked. And
// the session tokens were still sitting in KV until their own expiry, so the
// only thing standing between a stale token and a live session was a config
// flag that a future request could flip back.
//
// Both are settled here instead: every non-owner session is struck dead where
// it lies, and the records say when access ended and why. Owners are left alone
// deliberately — an owner session rides on the owner key, not the code, and
// regenerating a code must never lock the owner out of their own library.
//
// The session rows are marked rather than deleted, and it is worth being clear
// why, because deleting them looks tidier. A token with no row behind it is
// "Session expired. Sign in again." — which is what the app would then tell
// someone whose access had just been deliberately ended, in the middle of a
// service, and it is not true. A row that says how it died can say so. The mark
// is checked before anything else, so a marked session is exactly as dead as a
// missing one; it just knows its own cause of death. They lapse on their own
// once the explanation has stopped being worth anything.
const ENDED_SESSION_TTL = 30 * 24 * 60 * 60;

async function endCodeSessions(env, cfg, reason) {
  const ended = [];
  let cursor;
  do {
    const page = await env.SPRO.list({ prefix: "sess:", cursor, limit: 200 });
    for (const k of page.keys) {
      const rec = await env.SPRO.get(k.name, "json");
      if (!rec || rec.role === "owner" || rec.codeEnded) continue;
      rec.codeEnded = true;
      rec.codeEndedAt = now();
      rec.codeEndedReason = reason;
      await env.SPRO.put(k.name, JSON.stringify(rec), { expirationTtl: ENDED_SESSION_TTL });
      ended.push(rec.id);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  // The mirror the owner reads. Marked rather than deleted: who had access, and
  // until when, is exactly the kind of thing worth still being able to answer
  // next month.
  const ttl = cfg.policy.sessionDays * 24 * 60 * 60;
  for (const id of ended) {
    const key = "collab:" + id;
    const rec = await env.SPRO.get(key, "json");
    if (!rec || rec.role === "owner" || rec.revoked) continue;
    rec.revoked = true;
    rec.revokedAt = now();
    rec.revokedReason = reason;
    await env.SPRO.put(key, JSON.stringify(rec), { expirationTtl: ttl });
  }
  return ended.length;
}

async function handleCodeRotate(request, env, actor, cfg) {
  requireRole(actor, "admin");
  const body = await request.json().catch(() => ({}));
  const code = generateCode();
  const saltStd = b64std(randomBytes(16));

  const next = {
    ...cfg,
    codeSalt: saltStd,
    codeHash: await derive(normalizeCode(code), saltStd),
    codeVersion: cfg.codeVersion + 1,
    codeCreatedAt: now(),
    codeExpiresAt: body.expiresInDays ? now() + body.expiresInDays * 24 * 60 * 60 * 1000 : 0,
    codeRevoked: false
  };
  if (typeof body.rotateEndsSessions === "boolean") next.rotateEndsSessions = body.rotateEndsSessions;
  if (ROLES.includes(body.defaultRole)) next.defaultRole = body.defaultRole;
  await putConfig(env, next);

  const ended = next.rotateEndsSessions
    ? await endCodeSessions(env, next, "access code regenerated")
    : 0;

  await audit(env, actor, "code.rotate", {
    note: `access code regenerated (v${next.codeVersion})` +
      (next.rotateEndsSessions
        ? ` — ${ended} collaborator session${ended === 1 ? "" : "s"} ended, everyone must rejoin`
        : " — existing collaborators kept access")
  });

  // The only time the plaintext code is ever returned, and only to an owner
  // session. It is not stored anywhere in this form.
  return {
    code,
    codeVersion: next.codeVersion,
    expiresAt: next.codeExpiresAt,
    rotateEndsSessions: next.rotateEndsSessions,
    endedSessions: ended
  };
}

async function handleCodeRevoke(request, env, actor, cfg) {
  requireRole(actor, "admin");
  const next = { ...cfg, codeRevoked: true, codeVersion: cfg.codeVersion + 1 };
  await putConfig(env, next);
  // Revoking is the stronger action of the two — nobody new *and* nobody
  // already in — so it ends sessions whatever rotateEndsSessions says.
  const ended = await endCodeSessions(env, next, "access code revoked");
  await audit(env, actor, "code.revoke", {
    note: `access code revoked — nobody new can join, ${ended} session${ended === 1 ? "" : "s"} ended`
  });
  return { ok: true, endedSessions: ended };
}

async function handleCollaborators(env, actor) {
  requireRole(actor, "admin");
  const out = [];
  let cursor;
  do {
    const page = await env.SPRO.list({ prefix: "collab:", cursor, limit: 200 });
    for (const k of page.keys) {
      const rec = await env.SPRO.get(k.name, "json");
      if (rec) out.push(rec);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  out.sort((a, b) => (b.joinedAt || 0) - (a.joinedAt || 0));
  return { collaborators: out };
}

async function handleCollaboratorPatch(request, env, actor, cfg, id) {
  requireRole(actor, "admin");
  const body = await request.json().catch(() => ({}));
  const key = "collab:" + id;
  const rec = await env.SPRO.get(key, "json");
  if (!rec) throw new HttpError(404, "not_found", "No such collaborator.");
  if (rec.id === actor.id && (body.revoked || body.role)) {
    // Otherwise an owner can lock themselves out of their own library, and
    // there is no support desk to call.
    throw new HttpError(400, "self", "You cannot change your own access here.");
  }

  if (typeof body.revoked === "boolean") rec.revoked = body.revoked;
  if (ROLES.includes(body.role)) {
    if (body.role === "owner") throw new HttpError(403, "forbidden", "Ownership cannot be handed over from here.");
    rec.role = body.role;
  }
  await env.SPRO.put(key, JSON.stringify(rec), { expirationTtl: cfg.policy.sessionDays * 24 * 60 * 60 });
  await audit(env, actor, "member.update", {
    note: `${rec.name}: role=${rec.role}${rec.revoked ? ", access revoked" : ""}`,
    targetId: rec.id
  });
  return { collaborator: rec };
}

async function handleAudit(request, env, actor, url) {
  requireRole(actor, "admin");
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 100));
  const page = await env.SPRO.list({ prefix: "audit:", limit, cursor: url.searchParams.get("cursor") || undefined });
  const entries = [];
  for (const k of page.keys) {
    const rec = await env.SPRO.get(k.name, "json");
    if (rec) entries.push(rec);
  }
  return { entries, cursor: page.list_complete ? null : page.cursor };
}

async function handlePolicy(request, env, actor, cfg) {
  requireRole(actor, "admin");
  const body = await request.json().catch(() => ({}));
  const policy = { ...cfg.policy };
  for (const k of Object.keys(DEFAULT_POLICY)) {
    if (k in body) policy[k] = body[k];
  }
  const next = { ...cfg, policy };
  if (ROLES.includes(body.defaultRole)) next.defaultRole = body.defaultRole;
  await putConfig(env, next);
  await audit(env, actor, "policy.update", { note: JSON.stringify(body).slice(0, 300) });
  return { policy: next.policy, defaultRole: next.defaultRole };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function route(request, env) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;

  if (p === "/" || p === "/health") {
    return { ok: true, version: VERSION };
  }

  // Reads are public by design: the library lives in a public repo, and every
  // display on the stage has to be able to load it with no credential at all.
  if (p === "/library" && method === "GET") {
    const { lib } = await readLibrary(env);
    return {
      v: lib.v,
      songs: lib.songs.filter((s) => !s.deletedAt),
      setlist: lib.setlist,
      setlistAt: lib.setlistAt
    };
  }

  if (p === "/auth/join" && method === "POST") return await handleJoin(request, env);
  if (p === "/auth/owner" && method === "POST") return await handleOwnerSignIn(request, env);

  // Everything past here needs a session.
  const { actor, cfg } = await authenticate(request, env);

  if (p === "/auth/me" && method === "GET") {
    return {
      me: { id: actor.id, name: actor.name, role: actor.role, joinedAt: actor.joinedAt },
      policy: cfg.policy,
      // So the client can grey out what it must not offer. The server does not
      // trust this to have been honoured.
      can: Object.fromEntries(Object.entries(CAN).map(([k, v]) => [k, v.includes(actor.role)]))
    };
  }

  if (p === "/auth/leave" && method === "POST") {
    const header = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    await env.SPRO.delete("sess:" + (await sha256Hex(header.trim())));
    return { ok: true };
  }

  if (p === "/trash" && method === "GET") {
    const { lib } = await readLibrary(env);
    const cutoff = cfg.policy.retentionDays * 24 * 60 * 60 * 1000;
    return {
      songs: lib.songs
        .filter((s) => s.deletedAt)
        .map((s) => ({
          id: s.id,
          title: s.title,
          author: s.author || "",
          slides: Array.isArray(s.slides) ? s.slides.length : 0,
          deletedAt: s.deletedAt,
          deletedBy: s.deletedBy || "?",
          purgeableAt: s.deletedAt + cutoff
        }))
        .sort((a, b) => b.deletedAt - a.deletedAt),
      retentionDays: cfg.policy.retentionDays
    };
  }

  if (p === "/songs" && method === "POST") return await handleCreate(request, env, actor, cfg);
  if (p === "/songs/bulk-delete" && method === "POST") return await handleDelete(request, env, actor, cfg, null);
  if (p === "/songs/bulk-restore" && method === "POST") return await handleRestore(request, env, actor, cfg, null);
  if (p === "/songs/purge" && method === "POST") return await handlePurge(request, env, actor, cfg, null);
  if (p === "/setlist" && method === "PUT") return await handleSetlist(request, env, actor, cfg);
  if (p === "/trash/empty" && method === "POST") return await handleEmptyTrash(request, env, actor, cfg);

  let m;
  if ((m = p.match(/^\/songs\/([A-Za-z0-9_]+)$/))) {
    if (method === "PATCH") return await handleUpdate(request, env, actor, cfg, m[1]);
    if (method === "DELETE") return await handleDelete(request, env, actor, cfg, m[1]);
  }
  if ((m = p.match(/^\/songs\/([A-Za-z0-9_]+)\/restore$/)) && method === "POST") {
    return await handleRestore(request, env, actor, cfg, m[1]);
  }
  if ((m = p.match(/^\/songs\/([A-Za-z0-9_]+)\/purge$/)) && method === "POST") {
    return await handlePurge(request, env, actor, cfg, m[1]);
  }

  if (p === "/admin/code" && method === "POST") return await handleCodeRotate(request, env, actor, cfg);
  if (p === "/admin/code" && method === "DELETE") return await handleCodeRevoke(request, env, actor, cfg);
  if (p === "/admin/code" && method === "GET") {
    requireRole(actor, "admin");
    return {
      // The code itself is not recoverable — only regenerable. That is the
      // point of storing a PBKDF2 digest instead of the code.
      active: !!cfg.codeHash && !cfg.codeRevoked,
      codeVersion: cfg.codeVersion,
      createdAt: cfg.codeCreatedAt,
      expiresAt: cfg.codeExpiresAt,
      defaultRole: cfg.defaultRole,
      rotateEndsSessions: cfg.rotateEndsSessions
    };
  }
  if (p === "/admin/collaborators" && method === "GET") return await handleCollaborators(env, actor);
  // "-" is accepted here even though ids no longer contain one: sessions issued
  // before the id generator changed are still live, and their owner still has
  // to be able to revoke them.
  if ((m = p.match(/^\/admin\/collaborators\/([A-Za-z0-9_-]+)$/)) && method === "PATCH") {
    return await handleCollaboratorPatch(request, env, actor, cfg, m[1]);
  }
  if (p === "/admin/policy" && method === "POST") return await handlePolicy(request, env, actor, cfg);
  if (p === "/audit" && method === "GET") return await handleAudit(request, env, actor, url);

  throw new HttpError(404, "not_found", "No such endpoint.");
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }
    // A browser that is not one of ours gets nothing, which keeps a random page
    // from riding a signed-in volunteer's session.
    const origin = request.headers.get("Origin");
    if (origin && !originAllowed(origin, env)) {
      return json({ error: "origin", message: "Origin not allowed." }, 403, request, env);
    }

    try {
      const body = await route(request, env);
      return json(body, 200, request, env);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: err.code, message: err.message, ...(err.extra || {}) }, err.status, request, env);
      }
      // Never let an internal message out: it is the one place a token or a
      // path could leak into a response body.
      console.error("unhandled", err && err.stack);
      return json({ error: "internal", message: "Something went wrong on the server." }, 500, request, env);
    }
  }
};
