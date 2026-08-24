# QR Attendance

A class attendance system. The instructor projects a QR code that rotates every
15 seconds; students scan it with their phone and are marked present for that
date. The instructor can download an `.xlsx` matching their existing sheet
layout exactly.

No email, no student passwords. Identity is a device-bound UUID claimed once
the first time they scan; losing that binding needs an admin device reset.

**Postgres is the single source of truth.** Excel is generated on demand from it,
never the other way round. Nothing writes to a spreadsheet file at runtime.

## Stack

Next.js (App Router) on Vercel · Supabase Postgres · `exceljs` for the export ·
no auth library — the admin is a single password in an env var.

## Setup

### 1. Create the database

In the Supabase SQL editor, run [`supabase/schema.sql`](supabase/schema.sql),
then seed the roster (`npm run seed`). That is the whole setup — `schema.sql` is
the single source of truth for the database and is idempotent, so re-running it
is safe.

There is no migrations folder. There used to be four numbered files, but the app
never went live: it existed only in demo while the identity design was being
worked out, so when it changed for the last time the tables were dropped and
recreated and the roster re-seeded from the spreadsheet. Migrating demo data
would have been ceremony over 47 rows that regenerate in a second, and it would
have left the schema as a pile of diffs to replay rather than one file to read.

Two scripts exist for that path:

| Script | What it does |
|---|---|
| [`supabase/reset.sql`](supabase/reset.sql) | drops every table — **only** safe while the roster is regenerable from the spreadsheet |
| [`supabase/alter-001-one-passkey.sql`](supabase/alter-001-one-passkey.sql) | the one-passkey-per-student change, kept as the record of it |

`alter-001` is history rather than a step: `schema.sql` already contains
everything it did. It is worth reading if you want to see what changed and why.
The code it replaced is in [`docs/superseded/`](docs/superseded/).

**Before students register, settle your final hostname.** A passkey is bound to
its domain, so moving from `*.vercel.app` to a real domain later invalidates
every passkey and the whole class has to register again. Set `APP_ORIGIN` to the
domain you intend to keep.

### 2. Configure the app

```bash
cp .env.example .env.local
```

| Variable | Where it comes from |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | same page — **server-side only** |
| `ADMIN_PASSWORD` | your choice; changing it signs out every admin session |
| `CLASS_TIMEZONE` | optional, defaults to `Asia/Kolkata` |
| `ADMIN_ROLL_NO` | optional — the instructor's own roll number, if they are one of the 47 |

### 3. Seed the roster

```bash
npm run seed -- "Soft Skills.xlsx"
```

Reads `Roll NO.` (B), `Name` (C) and `Mail Id` (D) from rows 2–48 and preserves
`S.No` (A) as the sort order. Idempotent: it upserts on `roll_no` and never
clears a device binding, so you can re-run it after fixing a name in the sheet.

### 4. Run

```bash
npm run dev
```

## Using it

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

### Registration, and why there is no window

A phone with no passkey is always offered registration. There used to be an
admin-controlled window; it was removed deliberately.

It only ever defended against somebody claiming an **unclaimed** roll number
unilaterally, and that case is self-correcting: the real student is told the
number is taken and the admin sorts it out. It gave no protection against the
case that actually has a motive, because that needs no window at all. So the
toggle, the timer, the countdown and the banner were machinery guarding a
narrow, recoverable case, and they are gone.

What authorises registration instead is **presence**: creating a passkey
requires a live QR token, which only exists on the projector in the room.

What is left is honest about its limits. Within a class, anyone holding a live QR
token can claim any roll number nobody has claimed yet. That is accepted: the
alternative is enrollment requiring the admin's assent for each of 47 students.
See **What this does not defend against** below.

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
sweeps live in [`src/lib/sweep.ts`](src/lib/sweep.ts) and neither is a scheduler.

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

## Why identity moved from localStorage, to a cookie, to passkeys

This changed three times. Each step was forced by a specific failure, and the
alternatives that look obvious were each rejected for a concrete reason. The
superseded code is preserved under [`docs/superseded/`](docs/superseded/).

### 1. A UUID in localStorage — the original design

On first scan the browser generated `crypto.randomUUID()`, kept it in
`localStorage`, and the server mapped it to a roll number. One phone, one
student, nothing to type after the first time.

It broke for three separate reasons:

**Safari deletes it.** Intelligent Tracking Prevention removes script-writable
storage — `localStorage`, IndexedDB, cookies written by JavaScript — after
roughly seven days of browser use without interaction on the site. **A weekly
class sits exactly on that boundary.** Reproduced on WebKit: register in week
one, purge, scan in week two, and the student was offered registration afresh
and then told *"that roll number is already registered on another phone"*. It
was their own phone. Every student, every week, needing an admin reset.

**An installed web app cannot see it.** iOS gives a home-screen web app its own
storage container. Register in Safari and the installed app sees nothing, and
vice versa — the same phone holding two unrelated identities, only one of which
can own the roll number. Worse, on iOS a QR scanned from the Camera app opens
the *default browser*, never the installed app, so a student who installed the
app could never scan into the container holding their binding.

**Anything the browser can read, a student can send.** The UUID was a bearer
token in readable storage.

### 2. Adding an httpOnly cookie — a real fix, but partial

A cookie set by the *server* is not script-writable, so ITP's seven-day cap does
not apply to it. Holding the same id in both places, with each recognised scan
rewriting the other, made either one surviving sufficient. This genuinely fixed
the weekly purge, and it is verified on production in both engines.

It did not fix the rest. Cookies are per-container too, so the iOS
installed-app split survived. Clearing website data still required an admin.
And it was still a bearer token — `httpOnly` stops *script* reading it, not a
determined student.

### 3. Passkeys — where it landed

A passkey lives in the OS credential store — iCloud Keychain, Google Password
Manager — not in the browser's storage box. That single fact resolves every
item above:

| Failure | Under passkeys |
|---|---|
| Safari's 7-day purge | Not web storage; unaffected |
| iOS installed-app container | Both containers reach the same keychain |
| Two Vercel hostnames | No per-origin storage carries identity |
| Cleared site data, private mode | Unaffected |
| New phone, same ecosystem | Syncs automatically |
| Admin device resets | Gone for cookies, cleared data and same-ecosystem phones. A genuinely lost phone needs one approval. |

And it is the first version that is not a bearer token: the private key is
non-extractable and using it needs the device plus its biometric. Handing a
friend your phone no longer marks you present.

**Two things must both hold to be marked present, and neither substitutes for
the other:**

- **who** — a passkey signature over a server-issued, single-use challenge
- **where** — a live rotating token, which only exists on the projector

The session cookie set after a successful assertion (`att_student`) is *only*
so `/me` can be read without a biometric prompt. It cannot mark anyone present.

### What we care about, and what the OS handles

Handled for us: key generation, biometric prompts, sync, backup, and migration
to a new phone. We store a credential id and a public key, and never see a
private key.

Ours to get right:

1. **One passkey per student**, enforced by a unique index on `student_id` —
   not by reading the table first and then writing. Postgres has no race window;
   check-then-insert does, and it was measured: three simultaneous claims on the
   same roll number let **two** through. A second claim becomes a request for the
   instructor rather than an error, so the honest case still has a route.

   This is a reversal. It was first built one-to-many, so that switching
   ecosystems needed nobody's permission — see **Lost or wiped phone** for the
   attack that made that untenable.
2. **Registration is authorised by presence, and presence is not identity.**
   Adding a *first* passkey needs a live QR token, so being in the room is the
   permission — no admin, no email. Claiming a roll number that is already taken
   needs a person, because a live QR token is visible to everybody in the room
   and a roll number is not a secret.
3. **The Relying Party ID is the domain.** Passkeys are bound to it. **Moving
   domains invalidates every passkey**, so settle the final hostname before the
   class registers.
4. **Old phones.** Below iOS 16 / Android 9 there are no passkeys. Those
   students are marked by hand on the grid — which is why no weaker second
   login path exists to be attacked instead.
5. **Verification is where the security lives.** Single-use challenges with
   expiry, expected origin and RP ID taken from server config rather than the
   request, signature checked against the stored public key, and a counter that
   must advance. `@simplewebauthn/server` does the parsing; skipping any of
   those checks would leave a fingerprint prompt that proves nothing.

### Why not "Sign in with Microsoft"

The roster is 47 students, all on `@iiitb.ac.in`, which is Microsoft 365 — so
Entra ID would have mapped cleanly, and it would have fixed the recovery problem
just as well. It was rejected on three grounds:

- **It needs an app registration in the institute's tenant.** A student cannot
  create one. That is a dependency on an IT department, on a timeline nobody
  here controls, for an external app requesting sign-in across all students.
- **MFA in a lecture hall.** If the tenant enforces it, 47 Authenticator
  prompts land during class time.
- **It adds an outage surface.** A tenant policy change or a Microsoft outage
  would stop attendance. Nothing external can stop it today.

Passkeys give the same recovery benefit with no third party involved.

### Why not email OTP

It was considered and rejected because **it is weaker than what it would
replace**, not merely more work.

A passkey binds to a device. An OTP is six digits that travel over WhatsApp in
three seconds. Today a phone is one student permanently, so a student in class
physically cannot mark five absent friends. With OTP, one person collects five
codes and marks all five in under a minute. It hands out a mass-proxy tool.

### What none of this fixes

**Relaying the QR.** A student in the room photographs the projected code and
sends it to an absent friend, who signs in as themselves, with their own
biometric, and is marked present. Passkeys, Microsoft SSO and OTP are all
equally powerless here, because they answer *who*, not *where*.

The only control is how long a photographed code stays usable:

| rotation | usable for |
|---|---|
| **10 s** | **10–20 s** |
| 15 s | 15–30 s |
| 30 s | 30–60 s |
| 60 s | 60–120 s |
| 120 s | 120–240 s |

A realistic relay takes 15–30 seconds, so **use the 10-second rotation for real
classes** — and project the QR large, because a fast rotation is unforgiving of
a code nobody at the back can read. Beyond that, the count on the grid against
the number of occupied seats is a better check than any cryptography.

## How the security works

### Rotating token

```
period = session.window_seconds               // admin's choice, 5–300, default 15
w      = floor(Date.now() / 1000 / period)
token  = base64url(hmacSha256(secret, `${sessionId}:${w}`)).slice(0, 12)
```

The period is not part of the HMAC input — `w` is already derived from it, so a
session rotating every 60 s produces an entirely different index sequence from one
rotating every 15 s. Changing the period therefore invalidates every token
already on screen, which is why the QR redraws within one old period.

The server accepts `w` and `w-1`, so a student mid-scan when the QR flips still
succeeds. It never accepts `w+1`.

A screenshotted QR is worthless roughly 15 seconds later, which is what kills
"WhatsApp the QR to the guy who skipped class." The secret never reaches the
browser: the admin page polls `GET /api/token?s=` for the current token only.

`/api/token` is **admin-gated**. The session id travels inside the QR URL, so an
open token endpoint would let any student who scanned once poll it forever and
relay live codes to someone who never turned up — defeating the rotation. Only
the projecting page needs it.

IP checks would be pointless here — everyone is on the same campus wifi.

### Identity

A **passkey**. The private key is generated in the phone's secure element, kept
in the OS credential store, and cannot be extracted — so unlike every earlier
version of this, identity is not a bearer token that can be copied or forwarded.

Marking present needs two independent things, and neither substitutes for the
other:

- **who** — a signature over a server-issued, single-use challenge, by a key
  whose public half is already stored against a student
- **where** — a live rotating QR token

The `att_student` cookie set after a successful assertion only lets `/me` be
read without another biometric prompt. It cannot mark anybody present.

A roll number from the client is trusted exactly once, at registration, and only
when accompanied by a live token. See **Why identity moved from localStorage, to
a cookie, to passkeys** above for what came before and why each step failed.

### Cookies and HTTPS

The admin cookie is marked `Secure` when the request actually arrived over
HTTPS, rather than whenever `NODE_ENV` says production. `next start` runs in
production mode, so keying off it marked the cookie `Secure` even on a plain
HTTP LAN address — where Safari drops it silently, as does Chrome for anything
but `localhost`. Sign-in then returned 200 and left you looking at the login
page. Deployments are unaffected: they are HTTPS, so the flag is still set.

### Guarding the credentials

Failed sign-ins are throttled per caller address: ten failures in fifteen minutes
returns `429` with a `retryAfterSeconds`, and a correct credential clears the
history.

**The correct password is honoured before the throttle is consulted.** That
matters here specifically: throttling keys on the caller's address, and behind
campus NAT the whole class shares one. Checking the limit first meant any student
could fail ten sign-ins and lock the admin out for fifteen minutes, mid-lesson.
Since an attacker's guesses are by definition wrong, counting only failures loses
nothing — brute force is still capped at ten tries a quarter hour — and the admin
can always get in. A deputy code can still be throttled out by a shared address,
which is a fair trade: codes are 59 bits of randomness, and the admin can clear
`login_attempts` or issue a new one. Each failure is **one row** in `login_attempts`, counted on read — not a
counter. A counter has to be read, modified and written back, so two failures
arriving together could each overwrite the other's count, which is exactly the
burst throttling exists to catch. Rows also prune with a `WHERE`, so nothing has
to cap how many addresses are tracked.

It lives in Postgres rather than process memory because the app runs serverless:
memory is per-instance and short-lived, so an in-memory counter would barely
inconvenience an attacker.

Roll numbers are matched **exactly and case-insensitively, in application code**
rather than with SQL `ilike`. In `LIKE`, `%` and `_` are wildcards, so
`MT202652_` would otherwise have matched a real student and let the caller enrol
as them.

Device ids are folded to lowercase before use. The UUID pattern is
case-insensitive but Postgres equality is not, so without the fold one phone
could hold two identities.

### Permissions

| | Identified by | Can do |
|---|---|---|
| **Admin** | `ADMIN_PASSWORD` → signed httpOnly cookie | everything |
| **Student** | `att_device` UUID → server-side lookup | mark self present, view and export own row |

Every write endpoint except `/api/mark` and `/api/enroll` checks the admin cookie
server-side. Nothing is gated on a value the client sends. Every table has RLS
enabled with no policies, so a leaked anon key grants nothing.

### The audit log

Not to police the admin — to protect them. When a student insists they attended
on the 14th and the record disagrees, the log settles it in one conversation.

## Testing

```bash
npm test         # unit: token windows and the export layout — touches no database
npm run lint
npm run typecheck
```

The token helpers and the spreadsheet layout are covered by unit tests, including
`w-1` acceptance, `w+1` rejection, and the `21 Aug 2026 → serial 46255` match
against the instructor's original file.

### The integration suites destroy real data

> **There is one Supabase project.** The suites under `test/local/` talk to the
> same database production uses, and each one opens by deleting attendance and
> sessions and nulling every device binding. On a teaching day that erases the
> register, and the `.xlsx` export is the only copy.

They therefore refuse to run unless you say so:

```bash
set -a; . ./.env.local; set +a
export ATT_ALLOW_DB_WIPE=1

node test/local/e2e.mjs                  # API contracts, auth, idempotency
node test/local/edge.mjs                 # real-world edge cases
node test/local/browser.mjs              # WebKit + Chromium: sign-in, QR, storage-denied
node test/local/mobile.mjs --theme dark  # 6 devices: overflow, tap targets, contrast
node test/local/mobile.mjs --theme light
node test/local/load.mjs                 # 47 concurrent scans, tap storms
node test/local/demo.mjs                 # watchable walkthrough in two phone windows
```

`select` and `count` are deliberately left unguarded, so you can inspect the
database without the flag. Only `patch` and `remove` are gated — see
[`test/local/db.mjs`](test/local/db.mjs).

**Before a class, export the register.** There are no database backups on the
Supabase free tier, so the spreadsheet is the backup.

### Theme

Light, Dark and Auto, offered on the home page, on `/me`, and under **More** on
the admin page. **Dark is the default**; change `DEFAULT_MODE` in
[`src/lib/theme.ts`](src/lib/theme.ts) to `'system'` to follow each device's own
setting instead.

Auto keeps following the device if its setting changes mid-session. The choice is
read through `useSyncExternalStore`, so switching in one tab updates the others.

The mechanism is worth knowing if you touch it: a small script inlined at the top
of `<body>` resolves light/dark/system into an explicit `data-theme` attribute
**before first paint**, so there is no white flash on a dark theme, and Tailwind's
`dark:` variant has a concrete attribute to match rather than only a media query.
`color-scheme` is set alongside it so native controls — date pickers, selects,
scrollbars — follow the theme too.

### Mobile and PWA

```bash
npm run e2e:mobile              # 171 checks across six phone sizes
npm run e2e:mobile -- --shots   # also writes screenshots per device
```

Runs against real engines — **WebKit for iOS Safari, Chromium for Android
Chrome** — at iPhone SE / 14 / 14 Pro Max, Pixel 7, Galaxy S9+ and a 280px
fold-closed worst case, over fourteen screens each: landing, sign-in, sign-in
with the password revealed, the offline page, the scan result, the student
calendar, the roster, the session setup and live panels, export, More,
temporary access with and without search results, the confirmation dialog, the
staged save bar, and the fullscreen QR. It measures rather than asserts: horizontal overflow,
every tap target against the 44px minimum, input font sizes, QR legibility,
WCAG AA text contrast, and manifest installability.

Pass `--theme light` or `--theme dark` to audit either palette; both are expected
to come back clean. Contrast is measured by resolving each colour through a
canvas rather than parsing it, because Tailwind v4 emits `lab()` and a naive
`rgb()` regex silently reports nonsense.

Three things it exists to catch, because all three were real:

- **Flex items refusing to shrink.** The roster row overflowed by 75px on an
  iPhone SE and 225px at 280px, because a flex child's `min-width: auto` will
  not go below its content. Fixed with `min-w-0` on the row.
- **Controls under 44px.** Padding-only utilities left buttons at 34px and the
  calendar arrows at 26px. `button`/`select` now carry a `min-height` at element
  level so a utility class cannot undercut it, and WebKit needs an explicit
  `height` on `select` because it ignores `min-height` on a native menulist.
- **iOS focus zoom.** Safari zooms the page when a focused field's text is under
  16px and never zooms back. Every field is now at least 16px, which is what
  allowed `maximum-scale=1` to be removed — blocking pinch-zoom fails WCAG 1.4.4
  and was only ever masking this.

The app installs to the home screen on both platforms: manifest with 192/512 and
maskable icons, an `apple-touch-icon`, `standalone` display, theme colour, and
safe-area insets so the grid clears the notch and home indicator. Long-pressing
the icon offers **My attendance** and **Admin** as shortcuts.

`start_url` is `/`, the chooser — not `/me`. Installed, the app runs without an
address bar, so landing an unregistered phone straight on `/me` left it looking
at "Not registered" with nothing to tap and no way to reach `/admin`. For the
same reason every terminal card — not registered, code expired, offline, no
connection — carries a link onward. A screen with no exit is a screen that
traps somebody. A deliberately
conservative service worker gives a real offline page instead of the browser's
error screen — it never caches `/api/`, because a cached "you are present" would
be a lie.

Icons are generated, not committed by hand:

```bash
npm run icons
```

### Load and edge cases

```bash
npm run e2e:load     # a class of 47 all scanning at once
npm run e2e:edge     # hostile input, races, boundaries
```

`e2e:load` runs six scenarios against a real database. Measured against Supabase
from a laptop (~300 ms per round trip), 47 simultaneous scans all succeed in
about one second, a triple-tap storm of 141 requests still yields exactly 47
rows, and latency is flat across repeated waves. Per-request latency is almost
entirely network distance: `/api/mark` makes three sequential database calls, so
it costs roughly 3 x RTT. Deployed next to the database that is tens of
milliseconds, not hundreds.

`e2e:edge` covers what a classroom actually produces: wildcards and 500-character
strings in the roll-number field, non-UUID device ids, three phones racing for
one roll number, two admins starting the same date at once, a scan colliding with
an admin tap, truncated JSON, SQL-looking text in the reason field, a class that
runs past midnight, grants that expire or are deleted mid-use, and brute-forced
passwords.

### End-to-end, against a real database

The build spec's test checklist is automated — 87 checks covering token rotation,
enrollment races, concurrent scans, backdated sessions, `/me` isolation, the
audit log, and the export.

Point it at any running instance plus that instance's database:

```bash
set -a; . ./.env.local; set +a      # or your staging env
npm run build
npm run e2e:serve &                 # serves on :3100
npm run e2e
```

Override `BASE_URL` to test a deployed instance instead of localhost.

**It deletes data.** Every run clears `sessions`, `attendance` and `audit_log`
and unbinds every device, so run it against a scratch project or before the term
starts — never against a database holding real attendance. As a safeguard it
refuses to start if `attendance` already has rows; pass `E2E_CONFIRM_WIPE=1` to
override that deliberately.

There is also a self-contained Docker stack (`npm run e2e:up` / `e2e:down`) that
runs Postgres and PostgREST locally, for testing without a Supabase project.

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

## Deliberately out of scope

Multi-class support, faculty accounts, geofencing, face recognition, native apps,
and any AI/LLM component — every rule here is deterministic, so a model would add
latency and failure modes for no benefit.

**Live sync to a OneDrive/Google Sheets file** was considered and rejected: it
needs an app registration, an OAuth consent flow, encrypted refresh-token
storage, and write-conflict handling, and it fails silently when a token goes
stale. On-demand export gives the same artifact with none of that, and bolts on
cleanly later because Postgres is already the source of truth.
