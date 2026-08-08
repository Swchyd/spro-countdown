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

## Tests

```bash
npm test
```

Runs the Worker's real code against a fake KV and a fake GitHub Contents API
that tracks `sha` and rejects stale writes, so the concurrency path is exercised
rather than assumed. Nothing touches the live repo.
