# Song library gatekeeper

The song library is `songs.json` in the public `Swchyd/spro-countdown` repo.
Reading it needs nothing — it is a public file, and every display on the stage
has to be able to load it with no credential at all.

Writing goes through this Worker.

## Why it exists

The GitHub token used to live in the browser's `localStorage`. That made every
device that could write able to write *anything*, because GitHub cannot tell
"edit one song" from "replace the file with `[]`" — both are the same `PUT` to
the Contents API, and a token is either allowed to make it or not.

Moving the token here means the browser sends *operations* instead of files, and
something that is not the browser decides whether each one is allowed. That is
what makes a rule like "a collaborator may not remove 400 songs" enforceable
rather than merely displayed.

## Deploying

```bash
cd worker
npm install

# 1. Storage for access codes, sessions, collaborators and the audit log
npx wrangler kv namespace create SPRO
#    → paste the printed id into wrangler.toml

# 2. A fine-grained GitHub PAT, Contents: Read and write, this repo only.
#    This is the only copy that needs to exist. Nobody has to be given it.
npx wrangler secret put GITHUB_TOKEN

# 3. The owner key. This is how you sign in as owner — it is NOT the access
#    code, is never shown in the app, and should be long and random.
npx wrangler secret put OWNER_KEY

npx wrangler deploy
```

Then point the app at it. In `index.html`:

```js
var API_BASE = "https://spro-library.samuelcahyadi-w.workers.dev";
```

For local development against `wrangler dev`, no edit is needed — set an
override in the browser console instead:

```js
localStorage.setItem("spro-api-base", "http://127.0.0.1:8787");
```

## First run

1. Open the song library, press ⚙, choose **I'm the owner**, enter the owner key.
2. Go to **Manage access** → **Regenerate code**.
3. The code is shown once. It is not stored anywhere it can be read back from —
   only a PBKDF2 digest is kept — so pass it on before leaving that screen.
4. Anyone with that code joins with their name and becomes a collaborator.

## Roles

| | Owner | Collaborator | Viewer |
|---|---|---|---|
| View, search, filter songs | ✓ | ✓ | ✓ |
| Add / edit songs | ✓ | ✓ | |
| Delete a song (to the trash) | ✓ | ✓ | |
| Restore from the trash | ✓ | ✓ *(configurable)* | |
| Permanently delete | ✓ | | |
| Empty the trash | ✓ | | |
| Manage the access code | ✓ | | |
| Manage collaborators | ✓ | | |
| View the activity log | ✓ | | |
| Change thresholds | ✓ | | |

Everyone joining with the access code lands on the role in `defaultRole`
(collaborator unless changed). The owner can move any individual to viewer, or
revoke them, from **Manage access** — that takes effect on their next request,
not their next sign-in.

Ownership cannot be transferred through the API. Owner is whoever holds the
owner key, which lives only in Worker secrets.

## Thresholds

Defaults are in `DEFAULT_POLICY` in `src/worker.js`, and every one of them can be
overridden per install by `POST /admin/policy` without redeploying.

| Setting | Default | What it does |
|---|---|---|
| `collaboratorBulkMax` | 25 | Most songs a collaborator may delete in one operation |
| `ownerBulkMax` | 500 | Same, for the owner |
| `maxFractionPerOp` | 0.30 | No single delete may remove more than this share of the live library — **the owner included** |
| `fractionFloor` | 20 | Below this many live songs the share rule is skipped, because 30% of 6 songs is not a useful limit |
| `confirmAbove` | 10 | Above this many records, a typed phrase is required |
| `retentionDays` | 30 | How long deleted songs stay before the trash sweep will touch them |
| `collaboratorsCanRestore` | true | Whether restoring is a collaborator's job or only the owner's |
| `sessionDays` | 60 | How long a session lasts before it has to be renewed |

The typed phrase is computed by the server from the number of records it
actually found, not from anything the client said. A client that lies about the
count cannot produce a phrase that matches, so the confirmation is bound to the
real blast radius rather than to whatever the dialog happened to display.

## Backup and recovery

There is no custom backup system, on purpose — the existing infrastructure is
already better than one.

Every accepted operation is a git commit authored under the name of the person
who made it. So:

- **Full history**: `git log -p songs.json`
- **Point in time**: `git show <sha>:songs.json > songs.json`
- **Who broke it**: the commit log, independently of the audit log in KV

The worst a stolen collaborator session can do is cause one more commit. It
cannot rewrite history, and it cannot reach the repo settings.

To make that airtight, block force-pushes and deletion on `main` — this is the
single most valuable protection in the whole system, because it is the one that
holds even if everything else fails:

```bash
gh api -X POST repos/Swchyd/spro-countdown/rulesets \
  -f name='protect main' -f target=branch -f enforcement=active \
  -F 'conditions[ref_name][include][]=refs/heads/main' \
  -F 'conditions[ref_name][exclude][]=' \
  -F 'rules[][type]=non_fast_forward' \
  -F 'rules[][type]=deletion'
```

## Restoring the library by hand

If `songs.json` is ever wrong and the trash is not enough:

```bash
git log --oneline songs.json          # find the last good commit
git show <sha>:songs.json > songs.json
git commit -am "Restore song library from <sha>"
git push
```

Clients pick it up on their next sync. Song ids are stable across a restore, so
setlists keep pointing at the right songs.

## Endpoints

Public:

- `GET /health`
- `GET /library` — live songs, no credential needed
- `GET /turn` — WebRTC relay credentials, no credential needed (see below)

Session required (`Authorization: Bearer <token>`):

- `POST /auth/join` `{ code, name }` · `POST /auth/owner` `{ key, name }`
- `GET /auth/me` · `POST /auth/leave`
- `GET /trash`
- `POST /songs` · `PATCH /songs/:id` · `DELETE /songs/:id`
- `POST /songs/:id/restore` · `POST /songs/bulk-delete` · `POST /songs/bulk-restore`
- `PUT /setlist`

Owner only:

- `POST /songs/:id/purge` · `POST /songs/purge` · `POST /trash/empty`
- `GET|POST|DELETE /admin/code`
- `GET /admin/collaborators` · `PATCH /admin/collaborators/:id`
- `POST /admin/policy`
- `GET /audit`

There is no route that edits or deletes an audit entry, for anyone.

## The stage relay (`/room/:code`)

How an operator and a display find each other.

Pairing used to be peer-to-peer over WebRTC. On one wifi that is ideal — the two
devices talk directly and nothing sits in the middle. On two networks it is
impossible: each device is behind its own NAT, neither can address the other,
and the only way through is a server both can reach. That is not a slow link, it
is no link, in either direction, which is what a tablet on a different wifi saw.

WebRTC's answer to that is a TURN server. The public ones are dead — measured on
2026-08-16 with `iceTransportPolicy: "relay"`, neither the PeerJS relay nor
openrelay.metered.ca returned a single relay candidate, while a plain STUN
control on the same machine gathered `host` and `srflx` normally — and
Cloudflare's own TURN wants a card on file before it will issue a key.

So the relay is a Durable Object here instead. Both devices dial *out* over
`wss` on 443, the one port every network has to let through, so there is no NAT
to traverse and no difference between "same wifi" and "opposite ends of the
city". It costs nothing: one room is a few hundred messages an hour, incoming
WebSocket messages bill at 20:1, and the free plan allows 100,000 requests a
day.

It also deletes a whole class of bug. The old broker only released a room code
when its socket closed, which closing a tab does not do, so a code stayed taken
and the app grew six "slots" per code to walk around its own zombies. Here an
operator returning to its own code replaces itself and is back in under a
second.

    GET /room/<4-8 digits>?role=op|display&dev=<device id>   (WebSocket)

`dev` is what makes a code safe to reuse. An operator arriving on a code that
already has one is either the same device coming back — allowed, and the stale
socket is closed with 4000 — or a different room that rolled the same six
digits, which is refused with `{"t":"taken"}` and closed with 4001. Replacing
blindly would put one church's timer on another church's stage.

Messages are relayed, not interpreted: `s` (state) and `pong` go operator →
displays, `ping`/`hello`/`need` go display → operator stamped with `from`, and
the operator is told `peers` whenever the head count changes. The object keeps
the last merged snapshot in memory so a display joining mid-service has
something immediately, but it is only ever an optimisation — the operator is
asked as well, and its two-second heartbeat would answer within one beat anyway.

WebRTC is still in the app underneath, used only when the socket will not open
at all. Falling back to it is falling back to what worked on one wifi before,
rather than to nothing.

## TURN credentials (`/turn`) — optional

Only feeds the WebRTC fallback above, and only matters if that fallback ever has
to carry a cross-network pairing. Everything works without it.

If you do want it: Cloudflare dashboard → **Media** → **Realtime** → **TURN
Server** → **Get Started** (it asks for a payment method; usage is $0 below
1,000 GB/month, shared with SFU) → create a key, then

```bash
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
npx wrangler deploy
```

Credentials are minted with a six-hour life and cached in KV for five, so a room
filling up costs one call rather than one per device. Unconfigured is a normal
state: `/turn` answers `200` with an empty list and `configured: false`.

## Tests

```bash
npm test
```

Runs the Worker's real code against a fake KV and a fake GitHub Contents API
that tracks `sha` and rejects stale writes, so the concurrency path is exercised
rather than assumed. Nothing touches the live repo.

The relay needs the Worker actually running — the thing under test is socket
behaviour, and there is no honest way to fake that:

```bash
npx wrangler dev --port 8787 --local    # one terminal
npm run test:relay                      # another
```
