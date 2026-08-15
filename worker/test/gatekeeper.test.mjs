// Gatekeeper tests.
//
// The Worker's real code runs here — nothing is reimplemented. What is faked is
// only what sits either side of it: KV, and GitHub's Contents API. The GitHub
// fake keeps a sha and rejects a stale one, so the concurrency path is exercised
// rather than assumed.
//
//   node test/gatekeeper.test.mjs

import worker from "../src/worker.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeKV() {
  const store = new Map();
  return {
    _store: store,
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = "", cursor, limit = 1000 } = {}) {
      const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? all.indexOf(cursor) + 1 : 0;
      const slice = all.slice(start, start + limit);
      const last = slice[slice.length - 1];
      const complete = start + slice.length >= all.length;
      return {
        keys: slice.map((name) => ({ name })),
        list_complete: complete,
        cursor: complete ? null : last
      };
    }
  };
}

// Stands in for the repo. `sha` moves on every write, and a PUT quoting an old
// one is refused exactly as GitHub refuses it — which is what the Worker's
// read-apply-retry loop is built around.
function makeGitHub(initial) {
  const state = {
    content: initial === null ? null : JSON.stringify(initial, null, 1),
    sha: initial === null ? null : "sha0",
    n: 0,
    commits: []
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes("api.github.com")) return realFetch(url, opts);

    if (!opts.method || opts.method === "GET") {
      if (state.content === null) return new Response("{}", { status: 404 });
      return new Response(
        JSON.stringify({ sha: state.sha, content: Buffer.from(state.content, "utf8").toString("base64") }),
        { status: 200 }
      );
    }
    if (opts.method === "PUT") {
      const body = JSON.parse(opts.body);
      if (state.sha && body.sha !== state.sha) return new Response("{}", { status: 409 });
      if (!state.sha && body.sha) return new Response("{}", { status: 409 });
      state.content = Buffer.from(body.content, "base64").toString("utf8");
      state.sha = "sha" + ++state.n;
      state.commits.push({ message: body.message, author: body.author && body.author.name });
      return new Response("{}", { status: 200 });
    }
    return new Response("{}", { status: 405 });
  };

  return {
    state,
    library: () => (state.content === null ? null : JSON.parse(state.content)),
    commits: () => state.commits
  };
}

const OWNER_KEY = "test-owner-key-9f3a";

function makeEnv(kv) {
  return {
    SPRO: kv,
    GITHUB_TOKEN: "ghp_fake",
    OWNER_KEY,
    GH_OWNER: "Swchyd",
    GH_REPO: "spro-countdown",
    GH_FILE: "songs.json",
    GH_BRANCH: "main",
    ALLOWED_ORIGINS: ""
  };
}

async function call(env, path, { method = "GET", body, token, ip = "1.2.3.4", origin } = {}) {
  const headers = { "Content-Type": "application/json", "CF-Connecting-IP": ip };
  if (token) headers.Authorization = "Bearer " + token;
  if (origin) headers.Origin = origin;
  const req = new Request("https://gate.example" + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const res = await worker.fetch(req, env);
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, body: json || {} };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];
let group = "";

function section(name) {
  group = name;
  console.log("\n" + name);
  console.log("-".repeat(name.length));
}

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log("  PASS  " + label);
  } else {
    failures.push(group + " › " + label + (detail ? "  [" + detail + "]" : ""));
    console.log("  FAIL  " + label + (detail ? "  [" + detail + "]" : ""));
  }
}

function song(id, title) {
  return {
    id,
    title,
    slides: [["line one", "line two"]],
    sections: [],
    order: [],
    tags: [],
    notes: [],
    perSlide: 4
  };
}

async function setup(initialLibrary = { v: 2, songs: [], setlist: [], setlistAt: 0 }) {
  const kv = makeKV();
  const env = makeEnv(kv);
  const gh = makeGitHub(initialLibrary);
  const owner = await call(env, "/auth/owner", { method: "POST", body: { key: OWNER_KEY, name: "Sam" } });
  const rot = await call(env, "/admin/code", { method: "POST", body: {}, token: owner.body.token });
  return { env, kv, gh, ownerToken: owner.body.token, code: rot.body.code };
}

// ---------------------------------------------------------------------------

async function testAuthentication() {
  section("Authentication");
  const { env, code } = await setup();

  let r = await call(env, "/auth/join", { method: "POST", body: { code, name: "John" } });
  check("valid access code joins", r.status === 200 && r.body.me.role === "collaborator", "status " + r.status);

  r = await call(env, "/auth/join", { method: "POST", body: { code: "AAAA-BBBB-CCCC", name: "Nobody" }, ip: "9.9.9.1" });
  check("invalid access code is refused", r.status === 403 && r.body.error === "bad_code", "status " + r.status);

  r = await call(env, "/auth/owner", { method: "POST", body: { key: "wrong", name: "X" }, ip: "9.9.9.2" });
  check("wrong owner key is refused", r.status === 403 && r.body.error === "bad_key", "status " + r.status);

  r = await call(env, "/songs", { method: "POST", body: { song: song("s_x1", "No session") } });
  check("no session cannot write", r.status === 401, "status " + r.status);

  r = await call(env, "/songs", { method: "POST", body: { song: song("s_x1", "Bad token") }, token: "made-up" });
  check("forged bearer token is refused", r.status === 401, "status " + r.status);

  r = await call(env, "/auth/join", { method: "POST", body: { code, name: "Bad origin" }, origin: "https://evil.example" });
  check("disallowed origin is refused", r.status === 403 && r.body.error === "origin", "status " + r.status);
}

async function testBruteForce() {
  section("Brute force");
  const { env } = await setup();
  const ip = "5.5.5.5";
  let lockedAt = 0;
  for (let i = 1; i <= 12; i++) {
    const r = await call(env, "/auth/join", { method: "POST", body: { code: "ZZZZ-ZZZZ-ZZZ" + (i % 10), name: "x" }, ip });
    if (r.status === 429) { lockedAt = i; break; }
  }
  check("repeated wrong codes lock the address out", lockedAt > 0 && lockedAt <= 10, "locked at attempt " + lockedAt);

  const other = await call(env, "/auth/join", { method: "POST", body: { code: "QQQQ-QQQQ-QQQQ", name: "y" }, ip: "6.6.6.6" });
  check("the lockout is per address, not global", other.status === 403, "status " + other.status);
}

async function testRotationAndRevocation() {
  section("Access code rotation and revocation");
  const { env, ownerToken, code } = await setup();

  const joined = await call(env, "/auth/join", { method: "POST", body: { code, name: "John" } });
  const johnToken = joined.body.token;

  let r = await call(env, "/auth/me", { token: johnToken });
  check("collaborator session works before rotation", r.status === 200, "status " + r.status);

  const rot = await call(env, "/admin/code", { method: "POST", body: {}, token: ownerToken });
  const newCode = rot.body.code;
  check("regenerated code is different", newCode && newCode !== code);

  r = await call(env, "/auth/join", { method: "POST", body: { code, name: "John again" }, ip: "7.7.7.1" });
  check("old code stops working after regeneration", r.status === 403, "status " + r.status);

  r = await call(env, "/auth/me", { token: johnToken });
  check("regeneration signs existing collaborators out", r.status === 403 && r.body.error === "code_rotated", "status " + r.status);

  r = await call(env, "/auth/me", { token: ownerToken });
  check("regeneration does not sign the owner out", r.status === 200, "status " + r.status);

  check("regeneration reports how many it signed out", rot.body.endedSessions === 1,
    "ended " + rot.body.endedSessions);

  // The owner has to be able to see that it worked. A list that still says
  // "active" for the person just put out is the same as no answer at all.
  r = await call(env, "/admin/collaborators", { token: ownerToken });
  const john = r.body.collaborators.find((c) => c.name === "John");
  check("the collaborator list shows them out", john && john.revoked === true,
    JSON.stringify(john));
  check("and says why", john && /regenerated/.test(john.revokedReason || ""),
    john && john.revokedReason);
  const ownerRow = r.body.collaborators.find((c) => c.role === "owner");
  check("the owner is not marked out", ownerRow && !ownerRow.revoked, JSON.stringify(ownerRow));

  r = await call(env, "/auth/join", { method: "POST", body: { code: newCode, name: "John" }, ip: "7.7.7.2" });
  const johnAgain = r.body.token;
  check("new code works", r.status === 200, "status " + r.status);

  // Turning the flag off must not resurrect a session an owner already ended:
  // the sweep marks the session itself, so there is no configuration left that
  // could let the old token back in.
  const rot2 = await call(env, "/admin/code", {
    method: "POST", body: { rotateEndsSessions: false }, token: ownerToken
  });
  r = await call(env, "/auth/me", { token: johnToken });
  check("a session ended earlier stays ended when the flag is turned off",
    r.status === 403 && r.body.error === "code_rotated", "status " + r.status);
  check("and turning the flag off keeps the current sessions", rot2.body.endedSessions === 0,
    "ended " + rot2.body.endedSessions);
  r = await call(env, "/auth/me", { token: johnAgain });
  check("that rotation left the session it was told to leave", r.status === 200, "status " + r.status);

  const rev = await call(env, "/admin/code", { method: "DELETE", token: ownerToken });
  r = await call(env, "/auth/join", { method: "POST", body: { code: rot2.body.code, name: "John" }, ip: "7.7.7.3" });
  check("revoked code lets nobody in", r.status === 403, "status " + r.status);

  // Revoking is the stronger of the two, so it ends sessions whatever the flag
  // says — otherwise "revoke" would only mean "nobody new", which is not what
  // an owner reaching for it wants.
  r = await call(env, "/auth/me", { token: johnAgain });
  check("revoking the code signs everyone already in out",
    r.status === 403 && r.body.error === "code_rotated", "status " + r.status);
  check("revoking reports how many it signed out", rev.body.endedSessions === 1,
    "ended " + rev.body.endedSessions);
  r = await call(env, "/auth/me", { token: ownerToken });
  check("revoking does not sign the owner out", r.status === 200, "status " + r.status);
}

async function testOwnerAndCollaboratorCrud() {
  section("Everyday editing");
  const { env, gh, ownerToken, code } = await setup();
  const john = (await call(env, "/auth/join", { method: "POST", body: { code, name: "John" } })).body.token;

  let r = await call(env, "/songs", { method: "POST", body: { song: song("s_grace", "Amazing Grace") }, token: john });
  check("collaborator can add a song", r.status === 200 && r.body.song.version === 1, "status " + r.status);

  r = await call(env, "/songs/s_grace", {
    method: "PATCH",
    body: { song: { title: "Amazing Grace (v2)" }, baseVersion: 1 },
    token: john
  });
  check("collaborator can edit a song", r.status === 200 && r.body.song.version === 2, "status " + r.status);

  r = await call(env, "/songs", { method: "POST", body: { opId: "op-dup", song: song("s_dup", "Once") }, token: john });
  const again = await call(env, "/songs", { method: "POST", body: { opId: "op-dup", song: song("s_dup", "Once") }, token: john });
  const dupCount = gh.library().songs.filter((s) => s.id === "s_dup").length;
  check("a replayed operation does not add the song twice", r.status === 200 && again.status === 200 && dupCount === 1, "copies " + dupCount);

  r = await call(env, "/songs/s_grace", { method: "DELETE", token: john });
  const stored = gh.library().songs.find((s) => s.id === "s_grace");
  check("delete is soft — the record is still there", r.status === 200 && !!stored, "status " + r.status);
  check("delete records when and by whom", stored.deletedAt > 0 && stored.deletedBy === "John");
  check("the song id is unchanged by deletion", stored.id === "s_grace");
  check("hidden is still written for older clients", stored.hidden === true);

  r = await call(env, "/trash", { token: john });
  check("deleted song appears in the trash", r.status === 200 && r.body.songs.some((s) => s.id === "s_grace"));

  r = await call(env, "/songs/s_grace/restore", { method: "POST", token: john });
  const restored = gh.library().songs.find((s) => s.id === "s_grace");
  check("restore brings it back", r.status === 200 && !restored.deletedAt && restored.hidden === false);

  r = await call(env, "/setlist", { method: "PUT", body: { setlist: [{ id: "s_grace", ms: 300000 }] }, token: john });
  check("collaborator can set the setlist", r.status === 200 && gh.library().setlist.length === 1);

  const commits = gh.commits().map((c) => c.message);
  check("commit messages name the person and the song", commits.some((m) => m === 'John added "Amazing Grace"'), commits[0]);
  check("commits are authored as the collaborator", gh.commits().every((c) => c.author));

  r = await call(env, "/songs", { method: "POST", body: { song: song("s_own", "Owner song") }, token: ownerToken });
  check("owner can add a song", r.status === 200, "status " + r.status);
}

async function testConcurrency() {
  section("Two people, one song");
  const { env, code } = await setup();
  const a = (await call(env, "/auth/join", { method: "POST", body: { code, name: "Ann" } })).body.token;
  const b = (await call(env, "/auth/join", { method: "POST", body: { code, name: "Ben" }, ip: "2.2.2.2" })).body.token;

  await call(env, "/songs", { method: "POST", body: { song: song("s_oceans", "Oceans") }, token: a });

  const first = await call(env, "/songs/s_oceans", {
    method: "PATCH",
    body: { song: { title: "Oceans — Ben's edit" }, baseVersion: 1 },
    token: b
  });
  check("the first save of version 1 succeeds", first.status === 200 && first.body.song.version === 2);

  const second = await call(env, "/songs/s_oceans", {
    method: "PATCH",
    body: { song: { title: "Oceans — Ann's edit" }, baseVersion: 1 },
    token: a
  });
  check("a second save of version 1 is refused, not silently applied", second.status === 409 && second.body.error === "conflict", "status " + second.status);
  check("the conflict says who got there first", second.body.theirs && second.body.theirs.updatedBy === "Ben");

  const resolved = await call(env, "/songs/s_oceans", {
    method: "PATCH",
    body: { song: { title: "Oceans — agreed" }, baseVersion: 2 },
    token: a
  });
  check("re-saving against the current version succeeds", resolved.status === 200 && resolved.body.song.version === 3);
}

async function testBulkProtection() {
  section("Bulk deletion limits");
  const sid = (i) => "s_" + String(i).padStart(3, "0");
  const many = { v: 2, songs: [], setlist: [], setlistAt: 0 };
  for (let i = 0; i < 100; i++) {
    many.songs.push({ ...song(sid(i), "Song " + i), version: 1, updatedAt: 1, hidden: false });
  }
  const { env, gh, ownerToken, code } = await setup(many);
  const john = (await call(env, "/auth/join", { method: "POST", body: { code, name: "John" } })).body.token;

  const ids = (n, from = 0) => Array.from({ length: n }, (_, i) => sid(i + from));

  let r = await call(env, "/songs/bulk-delete", { method: "POST", body: { ids: ids(5) }, token: john });
  check("a small bulk delete goes through", r.status === 200 && r.body.deleted === 5, "status " + r.status);

  r = await call(env, "/songs/bulk-delete", { method: "POST", body: { ids: ids(30, 10) }, token: john });
  check("a collaborator is capped at 25 per operation", r.status === 403 && r.body.error === "too_many", "status " + r.status + " " + r.body.error);

  r = await call(env, "/songs/bulk-delete", { method: "POST", body: { ids: ids(20, 10) }, token: john });
  check("a bulk delete over the confirm threshold needs the phrase", r.status === 428 && r.body.error === "confirm_required", "status " + r.status);
  check("the phrase carries the true count", r.body.phrase === "DELETE 20 SONGS", r.body.phrase);

  r = await call(env, "/songs/bulk-delete", { method: "POST", body: { ids: ids(20, 10), confirm: "DELETE ALL" }, token: john });
  check("a wrong phrase is refused", r.status === 428, "status " + r.status);

  r = await call(env, "/songs/bulk-delete", { method: "POST", body: { ids: ids(20, 10), confirm: "DELETE 20 SONGS" }, token: john });
  check("the right phrase lets it through", r.status === 200 && r.body.deleted === 20, "status " + r.status);

  // 75 live songs remain; 30% of 75 is 22, so 40 must be refused for breadth
  // even though the owner's own per-operation cap is far higher.
  r = await call(env, "/songs/bulk-delete", { method: "POST", body: { ids: ids(40, 30), confirm: "DELETE 40 SONGS" }, token: ownerToken });
  check("even the owner cannot remove a third of the library at once", r.status === 403 && r.body.error === "too_broad", "status " + r.status + " " + r.body.error);

  const live = gh.library().songs.filter((s) => !s.deletedAt).length;
  check("nothing was lost to the refused operations", live === 75, "live " + live);

  r = await call(env, "/songs/bulk-delete", { method: "POST", body: { ids: gh.library().songs.map((s) => s.id), confirm: "DELETE ALL" }, token: john });
  check("select-all-and-delete is refused outright", r.status === 403, "status " + r.status);
  check("the library survives select-all", gh.library().songs.filter((s) => !s.deletedAt).length === 75);
}

async function testPrivilegeSeparation() {
  section("What a collaborator cannot do");
  const { env, gh, ownerToken, code } = await setup();
  const john = (await call(env, "/auth/join", { method: "POST", body: { code, name: "John" } })).body.token;
  await call(env, "/songs", { method: "POST", body: { song: song("s_pp", "Purge me") }, token: john });
  await call(env, "/songs/s_pp", { method: "DELETE", token: john });

  let r = await call(env, "/songs/s_pp/purge", { method: "POST", body: { confirm: "DELETE FOREVER" }, token: john });
  check("collaborator cannot permanently delete", r.status === 403 && r.body.error === "forbidden", "status " + r.status);
  check("the song is still recoverable", !!gh.library().songs.find((s) => s.id === "s_pp"));

  r = await call(env, "/trash/empty", { method: "POST", body: { confirm: "EMPTY TRASH 1" }, token: john });
  check("collaborator cannot empty the trash", r.status === 403, "status " + r.status);

  r = await call(env, "/admin/code", { method: "POST", body: {}, token: john });
  check("collaborator cannot regenerate the access code", r.status === 403, "status " + r.status);

  r = await call(env, "/admin/code", { method: "GET", token: john });
  check("collaborator cannot read access code settings", r.status === 403, "status " + r.status);

  r = await call(env, "/admin/collaborators", { token: john });
  check("collaborator cannot list collaborators", r.status === 403, "status " + r.status);

  r = await call(env, "/admin/policy", { method: "POST", body: { collaboratorBulkMax: 9999 }, token: john });
  check("collaborator cannot relax the thresholds", r.status === 403, "status " + r.status);

  r = await call(env, "/audit", { token: john });
  check("collaborator cannot read the audit log", r.status === 403, "status " + r.status);

  r = await call(env, "/audit", { method: "DELETE", token: john });
  check("there is no route to delete audit entries", r.status === 404 || r.status === 403, "status " + r.status);

  r = await call(env, "/audit", { method: "POST", body: {}, token: ownerToken });
  check("not even the owner can write to the audit log", r.status === 404, "status " + r.status);

  // A collaborator promoted to viewer loses writing without being signed out.
  const list = await call(env, "/admin/collaborators", { token: ownerToken });
  const johnRec = list.body.collaborators.find((c) => c.name === "John");
  await call(env, "/admin/collaborators/" + johnRec.id, { method: "PATCH", body: { role: "viewer" }, token: ownerToken });
  r = await call(env, "/songs", { method: "POST", body: { song: song("s_v", "Viewer song") }, token: john });
  check("a viewer cannot add songs", r.status === 403, "status " + r.status);
  r = await call(env, "/trash", { token: john });
  check("a viewer can still read", r.status === 200, "status " + r.status);

  r = await call(env, "/admin/collaborators/" + johnRec.id, { method: "PATCH", body: { role: "owner" }, token: ownerToken });
  check("ownership cannot be handed over through the API", r.status === 403, "status " + r.status);

  await call(env, "/admin/collaborators/" + johnRec.id, { method: "PATCH", body: { revoked: true }, token: ownerToken });
  r = await call(env, "/auth/me", { token: john });
  check("revoking a collaborator ends their access immediately", r.status === 403 && r.body.error === "revoked", "status " + r.status);
}

async function testPermanentDeletionPath() {
  section("Permanent deletion, owner only");
  const { env, gh, ownerToken, code } = await setup();
  const john = (await call(env, "/auth/join", { method: "POST", body: { code, name: "John" } })).body.token;
  await call(env, "/songs", { method: "POST", body: { song: song("s_live", "Still here") }, token: john });
  await call(env, "/songs", { method: "POST", body: { song: song("s_bin", "In the bin") }, token: john });
  await call(env, "/songs/s_bin", { method: "DELETE", token: john });

  let r = await call(env, "/songs/s_live/purge", { method: "POST", body: { confirm: "DELETE FOREVER" }, token: ownerToken });
  check("a live song cannot be purged without being deleted first", r.status === 400 && r.body.error === "not_deleted", "status " + r.status);

  r = await call(env, "/songs/s_bin/purge", { method: "POST", token: ownerToken });
  check("purging without the phrase is refused", r.status === 428 && r.body.phrase === "DELETE FOREVER", "status " + r.status);

  r = await call(env, "/songs/s_bin/purge", { method: "POST", body: { confirm: "DELETE FOREVER" }, token: ownerToken });
  check("owner can purge a song that is already in the trash", r.status === 200 && !gh.library().songs.find((s) => s.id === "s_bin"));
  check("purging one song leaves the rest alone", !!gh.library().songs.find((s) => s.id === "s_live"));

  // Retention: something deleted a moment ago is not eligible for the sweep.
  await call(env, "/songs/s_live", { method: "DELETE", token: john });
  r = await call(env, "/trash/empty", { method: "POST", body: { confirm: "EMPTY TRASH 1" }, token: ownerToken });
  check("emptying the trash spares songs inside the retention window", r.status === 200 && r.body.purged === 0, JSON.stringify(r.body));
  check("the recently deleted song is still recoverable", !!gh.library().songs.find((s) => s.id === "s_live"));
}

async function testRecovery() {
  section("Recovery");
  const { env, gh, code } = await setup();
  const john = (await call(env, "/auth/join", { method: "POST", body: { code, name: "John" } })).body.token;

  for (let i = 0; i < 6; i++) {
    await call(env, "/songs", { method: "POST", body: { song: song("s_r" + i, "Recover " + i) }, token: john });
  }
  const ids = ["s_r0", "s_r1", "s_r2", "s_r3"];
  let r = await call(env, "/songs/bulk-delete", { method: "POST", body: { ids }, token: john });
  check("four songs delete together", r.status === 200 && r.body.deleted === 4, "status " + r.status);

  const stillStored = ids.every((id) => !!gh.library().songs.find((s) => s.id === id));
  check("all four are still on disk", stillStored);

  r = await call(env, "/songs/bulk-restore", { method: "POST", body: { ids }, token: john });
  check("all four restore together", r.status === 200 && r.body.restored === 4, "status " + r.status);

  const live = gh.library().songs.filter((s) => !s.deletedAt).length;
  check("the library is whole again", live === 6, "live " + live);

  const titles = gh.library().songs.map((s) => s.title).sort();
  check("titles survived the round trip", titles[0] === "Recover 0" && titles.length === 6);
}

async function testAuditLog() {
  section("Audit log");
  const { env, ownerToken, code } = await setup();
  const john = (await call(env, "/auth/join", { method: "POST", body: { code, name: "John" } })).body.token;
  const sarah = (await call(env, "/auth/join", { method: "POST", body: { code, name: "Sarah" }, ip: "3.3.3.3" })).body.token;

  await call(env, "/songs", { method: "POST", body: { song: song("s_ag", "Amazing Grace") }, token: john });
  await call(env, "/songs/s_ag", { method: "PATCH", body: { song: { title: "Amazing Grace (new)" }, baseVersion: 1 }, token: john });
  await call(env, "/songs", { method: "POST", body: { song: song("s_oc", "Oceans") }, token: sarah });
  await call(env, "/songs/s_oc", { method: "DELETE", token: sarah });
  await call(env, "/songs/s_oc/restore", { method: "POST", token: ownerToken });

  const r = await call(env, "/audit", { token: ownerToken });
  check("owner can read the activity log", r.status === 200 && r.body.entries.length > 0, "status " + r.status);

  const e = r.body.entries;
  const find = (action, title) => e.find((x) => x.action === action && x.title === title);
  check("it records who added what", !!find("song.create", "Amazing Grace") && find("song.create", "Amazing Grace").user === "John");
  check("it records the edit", !!find("song.update", "Amazing Grace (new)"));
  check("it records who deleted what", !!find("song.delete", "Oceans") && find("song.delete", "Oceans").user === "Sarah");
  check("it records the restore", !!find("song.restore", "Oceans") && find("song.restore", "Oceans").user === "Sam");

  const edit = find("song.update", "Amazing Grace (new)");
  check("an edit records the old and new value", !!edit.changes && edit.changes.some((c) => c.field === "title" && c.from === "Amazing Grace"));
  check("entries are newest first", e[0].at >= e[e.length - 1].at);
  check("every entry carries a timestamp, user and song", e.every((x) => x.at && x.user && x.action));
}

async function testEmptyLibrary() {
  section("Empty library");
  const { env, gh, ownerToken, code } = await setup();
  const john = (await call(env, "/auth/join", { method: "POST", body: { code, name: "John" } })).body.token;

  let r = await call(env, "/library");
  check("an empty library reads back cleanly", r.status === 200 && Array.isArray(r.body.songs) && r.body.songs.length === 0, "status " + r.status);

  r = await call(env, "/trash", { token: john });
  check("an empty trash reads back cleanly", r.status === 200 && r.body.songs.length === 0);

  r = await call(env, "/songs/bulk-delete", { method: "POST", body: { ids: [] }, token: john });
  check("deleting nothing is a bad request, not a crash", r.status === 400, "status " + r.status);

  r = await call(env, "/songs/s_nope", { method: "PATCH", body: { song: { title: "x" } }, token: john });
  check("editing a song that is not there gives 404", r.status === 404, "status " + r.status);

  r = await call(env, "/trash/empty", { method: "POST", body: { confirm: "EMPTY TRASH 0" }, token: ownerToken });
  check("emptying an empty trash is harmless", r.status === 200, "status " + r.status);

  r = await call(env, "/songs", { method: "POST", body: { song: song("s_first", "First song") }, token: john });
  check("the first song still adds normally", r.status === 200 && gh.library().songs.length === 1, "status " + r.status);
}

async function testFileCreation() {
  section("Library file does not exist yet");
  const kv = makeKV();
  const env = makeEnv(kv);
  const gh = makeGitHub(null);
  const owner = await call(env, "/auth/owner", { method: "POST", body: { key: OWNER_KEY, name: "Sam" } });
  const rot = await call(env, "/admin/code", { method: "POST", body: {}, token: owner.body.token });
  const john = (await call(env, "/auth/join", { method: "POST", body: { code: rot.body.code, name: "John" } })).body.token;

  const r = await call(env, "/songs", { method: "POST", body: { song: song("s_seed", "Seed") }, token: john });
  check("the first write creates the file", r.status === 200 && gh.library() && gh.library().songs.length === 1, "status " + r.status);
  check("the created file is schema v2", gh.library().v === 2);
}

async function testLegacyMigration() {
  section("Migration from the old format");
  const legacy = {
    v: 1,
    songs: [
      { id: "s_old1", title: "Old kept", slides: [["a"]], updatedAt: 111, hidden: false },
      { id: "s_old2", title: "Old deleted", slides: [["b"]], updatedAt: 222, hidden: true }
    ],
    setlist: [],
    setlistAt: 0
  };
  const { env, gh, code } = await setup(legacy);
  const john = (await call(env, "/auth/join", { method: "POST", body: { code, name: "John" } })).body.token;

  let r = await call(env, "/trash", { token: john });
  check("a v1 hidden song shows up in the trash", r.status === 200 && r.body.songs.some((s) => s.id === "s_old2"), "status " + r.status);

  r = await call(env, "/library");
  check("a v1 visible song is still visible", r.body.songs.some((s) => s.id === "s_old1"));
  check("a v1 hidden song is not in the live list", !r.body.songs.some((s) => s.id === "s_old2"));

  await call(env, "/songs", { method: "POST", body: { song: song("s_new", "New one") }, token: john });
  const lib = gh.library();
  check("the file is upgraded to v2 on first write", lib.v === 2);
  check("old ids are untouched by the upgrade", !!lib.songs.find((s) => s.id === "s_old1"));
  check("old songs gain a version number", lib.songs.find((s) => s.id === "s_old1").version === 1);
  check("hidden is preserved alongside deletedAt", lib.songs.find((s) => s.id === "s_old2").hidden === true);
}

async function testAuthorList() {
  section("More than one name on a song");
  const { env, gh, code } = await setup();
  const john = (await call(env, "/auth/join", { method: "POST", body: { code, name: "John" } })).body.token;

  let r = await call(env, "/songs", {
    method: "POST",
    body: { song: { ...song("s_many", "Many hands"), authors: ["Sari Simorangkir", "Yosia Karundeng"] } },
    token: john
  });
  check("a song can be created with several authors",
    r.status === 200 && r.body.song.authors.length === 2, "status " + r.status);
  check("the flat field is written alongside for older builds",
    r.body.song.author === "Sari Simorangkir, Yosia Karundeng", r.body.song.author);

  // The whole point of keeping both: an iPad that has not picked this build up
  // still reads `author`, and must not see an empty one.
  check("the stored song carries both", (() => {
    const s = gh.library().songs.find((x) => x.id === "s_many");
    return Array.isArray(s.authors) && s.authors.length === 2 && s.author === s.authors.join(", ");
  })());

  r = await call(env, "/songs/s_many", {
    method: "PATCH",
    body: { song: { authors: ["A", "B", "C", "B", "  ", "a"] }, baseVersion: 1 },
    token: john
  });
  check("duplicates and blanks are dropped, first spelling kept",
    JSON.stringify(r.body.song.authors) === JSON.stringify(["A", "B", "C"]),
    JSON.stringify(r.body.song.authors));

  // A client that has not been updated sends only the string. The list has to
  // follow it, or the two would disagree and the newer build would show stale
  // names.
  r = await call(env, "/songs/s_many", {
    method: "PATCH",
    body: { song: { author: "Solo Writer, Second Writer" }, baseVersion: 2 },
    token: john
  });
  check("an old client sending only the flat field still sets the list",
    JSON.stringify(r.body.song.authors) === JSON.stringify(["Solo Writer", "Second Writer"]),
    JSON.stringify(r.body.song.authors));

  r = await call(env, "/songs/s_many", {
    method: "PATCH",
    body: { song: { authors: Array.from({ length: 30 }, (_, i) => "W" + i) }, baseVersion: 3 },
    token: john
  });
  check("the list is capped", r.body.song.authors.length === 12, "got " + r.body.song.authors.length);

  // Nobody has to be re-typed for a song written before the list existed.
  const legacy = {
    v: 2,
    songs: [{ id: "s_leg", title: "Old", author: "First Name, Second Name", slides: [["a"]], version: 1, deletedAt: 1, deletedBy: "x" }],
    setlist: [], setlistAt: 0
  };
  const two = await setup(legacy);
  const jack = (await call(two.env, "/auth/join", { method: "POST", body: { code: two.code, name: "Jack" } })).body.token;
  r = await call(two.env, "/trash", { token: jack });
  const trashed = r.body.songs.find((s) => s.id === "s_leg");
  check("a song written before the list splits into one on the way out",
    JSON.stringify(trashed.authors) === JSON.stringify(["First Name", "Second Name"]),
    JSON.stringify(trashed && trashed.authors));
}

// ---------------------------------------------------------------------------

// Node has no PBKDF2 iteration limit, so nothing above catches a value Workers
// will refuse at runtime — which is exactly how 210000 reached production and
// failed the first time an access code was ever generated. Read the constant
// out of the source and assert it against the platform ceiling.
async function testPlatformLimits() {
  section("Platform limits");
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/worker.js", import.meta.url), "utf8")
  );
  const m = src.match(/const PBKDF2_ITERATIONS = (\d+)/);
  check("the PBKDF2 iteration count is declared", !!m);
  const iterations = m ? Number(m[1]) : Infinity;
  check(
    "PBKDF2 iterations are within the Workers ceiling of 100000",
    iterations <= 100000,
    "declared " + iterations
  );
  check("PBKDF2 iterations are not weakened below 100000", iterations >= 100000, "declared " + iterations);
}

// Ids are random, so a route pattern that rejects one character out of the
// generator's alphabet fails only for some people, some of the time — which is
// how this got through the first pass looking like flaky tests. Joining a crowd
// and revoking every one of them turns that into a deterministic check.
async function testCollaboratorIdsAreRoutable() {
  section("Collaborator ids survive the URL");
  const { env, ownerToken, code } = await setup();

  const N = 30;
  for (let i = 0; i < N; i++) {
    await call(env, "/auth/join", { method: "POST", body: { code, name: "Person " + i }, ip: "4.4.4." + i });
  }

  const list = await call(env, "/admin/collaborators", { token: ownerToken });
  const people = list.body.collaborators.filter((c) => c.role !== "owner");
  check(`all ${N} joined`, people.length === N, "got " + people.length);

  const badChars = people.filter((c) => !/^[A-Za-z0-9_]+$/.test(c.id));
  check("no id contains a character the route pattern rejects", badChars.length === 0, badChars.map((c) => c.id).join(","));

  let unreachable = [];
  for (const c of people) {
    const r = await call(env, "/admin/collaborators/" + c.id, {
      method: "PATCH",
      body: { revoked: true },
      token: ownerToken
    });
    if (r.status !== 200) unreachable.push(c.id + " → " + r.status);
  }
  check("every collaborator can be revoked by the owner", unreachable.length === 0, unreachable.slice(0, 3).join(" · "));
}

const suites = [
  testPlatformLimits,
  testCollaboratorIdsAreRoutable,
  testAuthentication,
  testBruteForce,
  testRotationAndRevocation,
  testOwnerAndCollaboratorCrud,
  testAuthorList,
  testConcurrency,
  testBulkProtection,
  testPrivilegeSeparation,
  testPermanentDeletionPath,
  testRecovery,
  testAuditLog,
  testEmptyLibrary,
  testFileCreation,
  testLegacyMigration
];

for (const s of suites) {
  try {
    await s();
  } catch (err) {
    failures.push(group + " › threw: " + (err && err.stack));
    console.log("  ERROR " + err.message);
  }
}

console.log("\n" + "=".repeat(50));
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
