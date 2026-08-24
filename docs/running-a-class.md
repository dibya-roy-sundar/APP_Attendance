# Running a class

Day-to-day operation: the grid, the panels, exports, and the deployment details that matter when something is slow.

[← back to the README](../README.md)

## Day to day

### First class of the term

1. Open `/admin` and sign in.
2. **Start session**, then **Show QR** and project it.
3. Students scan, type their roll number once, and are marked present.

### Every class after that

**Start session** — pick how long attendance stays open and how fast the QR
rotates — then **Show QR**. Students scan; the grid fills in live.

| Choice | Presets | Range |
|---|---|---|
| Open for | 15 / 30 / 45 / 60 / 90 / 120 min | 1 min – 10 hr |
| QR rotates every | 10 / 15 / 30 / 60 / 120 s | 5 – 300 s |

A shorter rotation is harder to forward; a longer one is easier to scan on a
weak camera. The grace window is always one period, so choosing 60 s also means
a screenshot stays usable for up to two minutes.

While a session is running, **Extend / stop** offers:

- **Extend** by 5, 10, 15 or 30 minutes. Time is added to the current end time,
  so extending twice adds twice. A session that is still running stays
  extendable even after midnight, when its `class_date` is legitimately
  yesterday; a session that has *lapsed* can only be reopened on its own date,
  so a backdated one never becomes scannable.
- **QR rotation** can be retuned mid-class. The projected code refreshes within
  one old period; tokens minted under the previous setting stop working.
- **Stop session** ends the QR immediately. Taps on the grid keep working.

### The instructor is one of the 47

Set `ADMIN_ROLL_NO` to their roll number and the grid marks that row **YOU**, so
they can find and tap it without hunting. They mark their own attendance the same
way as anyone else's — by scanning with their phone, or by tapping their row.

### The roster grid

Two sections, because they are used differently.

```
✓  scanned      ✎  marked by hand      ·  absent
```

**Marked** holds anyone already present. Scans land here on their own within five
seconds. These rows are **not tappable**: the one mistake that really costs
something is absenting a student who did turn up, and a stray thumb should not be
able to do it. Unmarking lives in that row's `⋯` menu, where it takes a
deliberate second tap.

Removing a mark asks first, but only when the student made it themselves: a `✓`
scan opens a dialog naming who they are and the minute they scanned, because that
mark is their own evidence of having been there. A `✎` mark the admin made by
hand goes straight through — it is theirs to undo. Either way an
`OVERRIDE_UNMARK` entry lands in the audit log.

**Not marked** holds everyone else, with a search box for when typing three
letters beats scrolling 47 rows, and **Select all** for the days when nearly
everyone is present — stage the lot, then un-stage the few who are not.

Select all is scoped to what is on screen. With a search applied it reads
"Select all 6 shown" and takes only those six; a control that quietly staged 41
hidden students would be a trap.

Tapping a row **stages** it — no request, no waiting. A bar appears at the bottom
showing how many are staged, with **Save** and **Discard**; it is absent when
nothing is staged.

Save writes the whole batch in one request. That is not only about speed:

- **It is idempotent.** `/api/marks` only inserts, so saving twice — or three
  saves racing — leaves exactly one row. The per-tap toggle it replaced read the
  current state before flipping it, so two taps landing together both saw
  "absent", both inserted, and the student ended up *marked* when two taps should
  have cancelled out. That was the miscounting.
- **A scan is never overwritten.** If somebody scans while staged they move to
  Marked as `✓` and drop out of the batch, because scanning is the better
  evidence. The save says so: *"Saved 5. 1 had already scanned."*
- **Ten taps cost one round trip.** Ten rows take about 380 ms, against the
  twelve seconds ten sequential writes used to take at ~1.5 s each.

An optional reason accompanies the save rather than each tap, which is both
simpler and a more honest description of what it refers to.

The date picker loads any past session into the same two-section view, so a
correction found a week later needs no new interaction to learn.

### Forgot to start a session

**More → Session for a past date**. This creates a session with `is_open = false`
and the chosen `class_date`, so no QR is ever generated for it. It opens straight
into the grid; tap through from memory or a paper list. Every mark lands as `✎`.

A date that already has a session is refused, and the existing one is opened
instead.

### A student joins late

**More → Roster → Add student.** Roll number and name are required, email is
optional. They take the next `S.No`, so they land at the end of the roster and of
the exported sheet rather than shifting everybody else's row, and classes already
held stay blank for them — which is the truth.

Adding students is the instructor's own operation; a deputy covering one class
cannot change who is on the register.

### Caching

`students` is read on nearly every request and changes a handful of times a term,
so `listStudents()` keeps it in memory for **30 seconds** and any write clears it.

Thirty seconds, not thirty days. This runs as several serverless instances with no
way to tell the others that a student was added, so a long TTL would mean an
instance serving a roster that is wrong for as long as the TTL lasts. The
instance that performs the write clears its own copy at once, so the admin who
added someone always sees them immediately.

Measured against Supabase from a laptop, roughly 300 ms per round trip:

| | before | after |
|---|---|---|
| `GET /api/roster` | 1092 ms (611–1182) | **604 ms** (577–697) |
| `POST /api/marks` | 1073 ms | **903 ms** |

The roster gain was a surprise — those queries already run in `Promise.all`, so
caching one was not expected to help. Removing it both lowered and steadied the
time, which points at connection contention rather than the queries genuinely
running in parallel.

What caching does **not** fix: the grid re-sends all 47 student records every
five seconds, 8.6 KB a poll, about 6 MB across an hour of class, almost all of it
names and roll numbers that never change. Splitting the poll into a rarely
fetched roster and a small marks-only payload is the larger win, and is a
client-side change rather than a cache.

### Lost or wiped phone

Most of the time, nothing for the admin to do.

**Cleared cookies, cleared site data, a new phone in the same ecosystem** — all
handled by the phone itself. The passkey lives in the OS credential store and
syncs through iCloud Keychain or Google Password Manager, so it is already on the
new device. `/me` offers **Sign in**, which is one biometric prompt and about
175 ms.

**A genuinely lost phone, or a move from iPhone to Android**, needs a decision by
a person, and this is the part that changed late.

Each student may hold **one** passkey, enforced by a unique index on
`student_id`. Entering a roll number that already has one does not create a
second — it files a **request**, visible under **More → Phone changes**, and the
instructor approves or refuses it. Approving *replaces* the old credential, so
one-per-student still holds afterwards.

That is deliberately more friction than the design it replaced, and the reason is
a hole the earlier one had. `student_credentials` was originally one-to-many, so
that switching ecosystems needed nobody's permission. But a roll number is not a
secret — it is printed on ID cards and read aloud in class — and the only thing
authorising registration is a live QR token, which everybody in the room can see.
So a stranger holding the projected QR could type a classmate's roll number, add
*their own* passkey to that student's record, and mark them present in every
class from then on. This was found by testing the attack, having previously been
written up as a feature.

There is no way for the server to tell a lost phone from an opportunist: both are
an unknown device asking for a roll number that is taken. So it stops asking, and
puts the question to somebody who is standing in the room with all 47 students.

Attendance is never affected by any of this. Those rows key on `student_id`, so
the record of who was present survives any number of device changes.

The only case still needing manual marking is a phone too old for passkeys —
below iOS 16 or Android 9. Tap that student on the grid. That is deliberate: a
weaker second sign-in path would just become the one worth attacking.

### The phone-changes panel

**More → Phone changes.** Seven days of claims, filterable by All / Pending /
Approved / Refused. Each row is the roll number, the name, the device that asked,
when, and what was decided. Two buttons on the pending ones.

It offers **no opinion on whether a claim is honest**, and that is a decision
rather than an omission. An earlier version showed whether the student was
already marked present today, and when their existing passkey last worked. Both
were removed: a proxy attempt happens while the student is absent, and so does a
genuine lost phone, so the common case for both looks identical. A hint that only
fires in the rare case is worse than no hint, because it invites trusting it
instead of asking the student — and the instructor has a far better instrument
available, which is to ask them to come to the front.

What the history *is* good for is patterns. The same roll number claimed three
times in a week is visible at a glance, and no heuristic was needed to surface it.

A refused claim is evidence, so it stays in the list for the week. The permanent
record is `audit_log`, which keeps every `PASSKEY_REQUESTED`, `PASSKEY_APPROVED`
and `PASSKEY_REJECTED` for good.

Rows past seven days are deleted, and so are lapsed WebAuthn challenges. Both
sweeps live in [`src/lib/sweep.ts`](../src/lib/sweep.ts) and neither is a scheduler.

The reasoning is the same for both: each table is already self-limiting *by
query*, not by cleanup. A lapsed challenge cannot be consumed because
consumption filters on `expires_at`; a stale request is invisible because the
panel filters on `requested_at`. Deleting the rows is therefore tidying, and
tidying has no business costing a student a round trip to Supabase while they
wait for a fingerprint prompt.

So both run *after* the response is sent, via `after()` from `next/server`. A
bare un-awaited promise would not do — on Vercel the container can be frozen the
moment the response is flushed, abandoning the delete halfway. Errors are
dropped: a cleanup that did not run has no visible consequence, the next call
attempts it again, and a failure here must never turn a working sign-in into a
broken one.

Measured on production, `POST /api/passkey/session/options` — the challenge every
sign-in starts with. Both deployments hit alternately from the same machine, both
warmed first, with 40 lapsed rows seeded so the DELETE had real work to do:

| | median | p90 | max |
|---|---|---|---|
| prune awaited in the request | 170 ms | 188 ms | 471 ms |
| prune behind the response | **153 ms** | **173 ms** | **176 ms** |

Roughly one Supabase round trip off the median — a modest 17 ms, and worth
stating plainly because a first pass at this measurement suggested far more. That
run compared a fresh deployment against a number taken minutes earlier and
reported 364 ms median against 2213 ms max; almost all of that spread was cold
starts, not the prune. Warm and interleaved is the only comparison that means
anything here.

The tail is the better argument: 471 ms down to 176 ms. The awaited version's
worst case is a student waiting on a DELETE that has nothing to do with them,
and a lecture hall is where that gets noticed.

One ordering hazard

One ordering hazard, worth knowing because it is invisible in a unit test: the
sweep is registered *before* the fresh challenge is stored but runs *after* it.
A predicate that caught the new row would delete the challenge the student is
about to sign with, and sign-ins would fail intermittently. The edge suite
asserts the minted challenge survives its own sweep and is still recognised by
the verify step.

If nothing is ever called, nothing is cleaned — accepted, for tables holding a
handful of rows a term.

A deputy can **see** the panel but not decide anything: both `decide` and
`remove` return `403`. Somebody covering one class needs to know a student is
stuck, but changing who owns a passkey belongs to the person who owns the
register.

### What a student sees

`/me` shows a **month calendar** of their own attendance — green for present, red
for absent, blank where no class was held — with the headline count and
percentage above it and every class listed below. Month arrows move between the
months that actually had classes.

An empty square means no class was held, which is materially different from being
absent; a flat list of dates cannot show that distinction at a glance.

### Export

**Download .xlsx** on the admin page, or `GET /api/export`. Generated from
Postgres on every request.

| Col | Header | Content |
|---|---|---|
| A | `S.No` | 1..47 |
| B | `Roll NO.` | roll number |
| C | `Name ` | name (trailing space matches the original) |
| D | `Mail Id` | email |
| E | `Date:` | label only |
| F–U | one per session | `✓` where an attendance row exists |
| V | `Total \nAttendnacs` | `=COUNTIF(F2:U2,"✓")` |
| W | `Attendnacs \n%` | `=IF(COUNT($F$1:$U$1)=0,"",V2/COUNT($F$1:$U$1))`, `0.0%` |

`V` and `W` are live formulas, not computed values. Scanned and manual marks both
write a plain `✓` — provenance stays out of this file so it remains diffable
against the instructor's own copy.

## Deploying

### Function region

`vercel.json` pins functions to `bom1` (Mumbai). This is not a preference —
it is worth 9x.

Requests were entering at `bom1` and executing in `iad1` (Washington), which
is what Vercel does when no region is set. Marking present takes two requests
and nine sequential Supabase round trips between them, and Supabase is in
Mumbai, so that crossing was paid nine times per sign-in:

| | before | after |
|---|---|---|
| passkey sign-in, API only | 2800 ms | **305 ms** |
| first registration | 3283 ms | **490 ms** |
| tap to "Present", in a browser | 3848 ms | **1024 ms** |

Check `x-vercel-id` after any deploy: the second field is the compute region,
and it should read `bom1::bom1`. If you move the Supabase project, move this
too — they need to be in the same place, and nothing will warn you.



Live at **https://app-attendance-lilac.vercel.app**.

```bash
vercel link
vercel env add SUPABASE_URL production          # and preview
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel env add ADMIN_PASSWORD production
vercel env add CLASS_TIMEZONE production
vercel env add ADMIN_ROLL_NO production
vercel deploy --prod
```

Four things that are easy to get wrong here:

- **Turn Deployment Protection off.** New Vercel projects enable Vercel
  Authentication, which redirects every request to an SSO login — students
  scanning the QR would hit a Vercel login wall instead of the attendance page.
  The admin side has its own password and every admin endpoint returns 401
  without a cookie, so the deployment itself must be publicly reachable.
- **Environment variables only apply to new deployments.** Changing one —
  `ADMIN_PASSWORD`, say — needs a redeploy before it takes effect.
- **The git commit author must be a member of the Vercel team**, or the
  deployment comes back `BLOCKED` rather than failing loudly. Check with
  `git log -1 --format=%ae` against the team's members.
- **Changing `ADMIN_PASSWORD` signs out every admin** and invalidates every
  outstanding deputy code, because both cookies are signed with it. That is the
  intended behaviour, and it is also how you revoke access in a hurry.
