# QR Attendance

A class attendance system. The instructor projects a QR code that rotates every
15 seconds; students scan it with their phone and are marked present for that
date. The instructor can download an `.xlsx` matching their existing sheet
layout exactly.

No email, no student passwords. Identity is a device-bound UUID claimed once
during an admin-controlled enrollment window.

**Postgres is the single source of truth.** Excel is generated on demand from it,
never the other way round. Nothing writes to a spreadsheet file at runtime.

## Stack

Next.js (App Router) on Vercel · Supabase Postgres · `exceljs` for the export ·
no auth library — the admin is a single password in an env var.

## Setup

### 1. Create the database

In the Supabase SQL editor, run [`supabase/schema.sql`](supabase/schema.sql).
It is idempotent, so re-running it is safe.

If your database predates the configurable QR rotation, run
[`supabase/migrations/001_configurable_window.sql`](supabase/migrations/001_configurable_window.sql)
as well — or just re-run `schema.sql`, which now carries the same `alter table`.

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
2. Open **More → Registration window**, choose how long (2 / 5 / 10 / 30 min)
   and tap **Open**. It closes itself when the time is up.
3. **Start session**, then **Show QR** and project it.
4. Students scan, type their roll number once, and are marked present.
5. Close the registration window afterwards. Nobody can claim a roll number
   while it is closed.

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

### The registration window

Registration is the one moment where knowing a roll number is enough to claim an
identity, and roll numbers are public. So it opens for **a chosen number of
minutes and shuts itself** — the failure that matters is leaving it open because
nobody remembered to close it.

While it is open the grid carries a banner naming the risk and counting down,
with **Close now** beside it. The automatic close is recorded in the audit log
against `system`, and a guarded update means several polls arriving at once log
it once rather than six times.

What this does **not** fix, and is worth knowing: within an open window, whoever
types a roll number first wins it. Somebody in the room can claim an absent
classmate before that classmate ever enrols, which marks them present. The real
student then sees "already registered on another phone" — indistinguishable from
honestly changing handset — and the fix is the same **Reset device**. Nobody
complains in the case that matters, because the absent student benefited. Keeping
the window down to a couple of supervised minutes is what limits it; closing it
properly needs enrollment to require the admin's assent rather than a public
roll number.

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

Tap **⋯** on the student's row → **Reset device**. That clears their binding and
grants them one fresh claim even while the registration window is closed.

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

### Device identity

The client generates `crypto.randomUUID()` once and keeps it in `localStorage`
under `att_device`. It is sent in the body of every request and **the server maps
`device_id` → student**. A roll number from the client is never trusted after
enrollment. One device per student, enforced by a unique constraint.

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
history. State lives in the `settings` table rather than process memory, because
the app runs serverless and an in-memory counter would reset on every cold start.

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
npm test        # unit: token windows and the export layout
npm run lint
npm run typecheck
```

The token helpers and the spreadsheet layout are covered by unit tests, including
`w-1` acceptance, `w+1` rejection, and the `21 Aug 2026 → serial 46255` match
against the instructor's original file.

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
