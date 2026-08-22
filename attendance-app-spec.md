# QR Attendance App — Build Spec

Hand this file to Claude Code as the starting prompt.

## Goal

A class attendance system. The instructor projects a QR code that rotates every 15
seconds. Students scan it with their phone and are marked present for that date.
The instructor can download an .xlsx matching an existing sheet layout exactly.

No email. No passwords for students. Identity is a device-bound cookie claimed once
during an admin-controlled enrollment window.

## Stack

- Next.js (App Router) deployed on Vercel
- Supabase (Postgres) — free tier
- `exceljs` for the export
- No auth library. Admin is a single password in an env var.

## Schema

```sql
create table students (
  id            uuid primary key default gen_random_uuid(),
  roll_no       text unique not null,
  name          text not null,
  email         text,
  device_id     text unique,          -- null until enrolled
  reset_allowed boolean not null default false,
  enrolled_at   timestamptz
);

create table sessions (
  id          uuid primary key default gen_random_uuid(),
  class_date  date not null,
  secret      text not null,          -- random 32 bytes, hex
  is_open     boolean not null default true,
  opened_at   timestamptz not null default now(),
  expires_at  timestamptz not null
);

create table attendance (
  session_id  uuid not null references sessions(id) on delete cascade,
  student_id  uuid not null references students(id) on delete cascade,
  marked_at   timestamptz not null default now(),
  device_id   text,
  source      text not null default 'scan',   -- 'scan' | 'manual'
  primary key (session_id, student_id)   -- makes double-marking impossible
);

create table settings (
  key   text primary key,
  value text not null
);
-- seed: ('enrollment_open', 'false')

create table audit_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  action     text not null,   -- OVERRIDE_MARK | OVERRIDE_UNMARK | RESET_DEVICE
                              -- | OPEN_ENROLLMENT | CLOSE_ENROLLMENT
  student_id uuid references students(id),
  session_id uuid references sessions(id),
  reason     text
);
```

**Postgres is the single source of truth.** Excel is generated on demand from it,
never the other way round. Nothing writes to a spreadsheet file at runtime.

Seed `students` from the provided xlsx: `Roll NO.` (col B), `Name` (col C),
`Mail Id` (col D), rows 2–48. 47 students.

## Rotating QR token

This is the one piece worth getting exactly right.

```
WINDOW  = 15                                  // seconds
w       = Math.floor(Date.now() / 1000 / WINDOW)
token   = base64url(hmacSha256(session.secret, `${session.id}:${w}`)).slice(0, 12)
```

QR encodes: `https://<app>/m?s=<session.id>&t=<token>`

**Server accepts `w` and `w-1`** — a student mid-scan when the QR flips must still
succeed. Never accept `w+1`. Reject anything else.

Admin page regenerates the QR client-side every 15s by polling a lightweight
`GET /api/token?s=<id>` — do not embed the secret in the browser.

Rationale: a screenshotted QR is worthless ~15 seconds later, which kills
"WhatsApp the QR to the guy who skipped class." IP-based checks are pointless
here — everyone is on the same campus wifi.

## Device identity

- On first visit, client generates `crypto.randomUUID()` and stores it in
  `localStorage` under `att_device`.
- Sent in the body of every request. **The server maps device_id → student.**
  Never trust a roll number sent from the client after enrollment.
- One device per student, enforced by the unique constraint on `students.device_id`.

## Routes

### `GET /m?s=&t=`  (student scan page)
1. Read `att_device` from localStorage (create if absent).
2. `POST /api/mark { s, t, deviceId }`.
3. Render one of: `✓ Present — <name>, <date>` / roll-number input form /
   `Not registered — ask the instructor` / `Code expired, scan again`.

### `POST /api/mark { s, t, deviceId }`
- Session exists, `is_open`, `now() < expires_at` → else `SESSION_CLOSED`.
- Token valid for window `w` or `w-1` → else `BAD_TOKEN`.
- Look up student by `device_id`:
  - found → insert into `attendance` (ignore conflict) → `MARKED { name }`
  - not found + `enrollment_open` → `NEEDS_ENROLL`
  - not found + closed → `NOT_REGISTERED`

### `POST /api/enroll { rollNo, deviceId, s, t }`
- Re-validate session + token (same rules — enrollment is also in-class only).
- `enrollment_open` must be true **OR** that student's `reset_allowed` is true.
- `rollNo` must exist in `students` → else `UNKNOWN_ROLL`.
- `students.device_id` must be null → else `ALREADY_CLAIMED`.
- Set `device_id`, `enrolled_at`, clear `reset_allowed`, then mark present.

### `GET /me`  (student, identified by device cookie — no login)
Read-only view of their own record:
- `Present: 12 / 14 — 85.7%`
- List of class dates with present/absent, most recent first.
- Optional **Download my attendance** button → single-row .xlsx.
- Unrecognized device → "Not registered — ask the instructor."

Students see only themselves here. This is the page they will actually use;
Excel on a phone with 23 columns is unusable.

### `GET /admin`  (password-gated, `ADMIN_PASSWORD` env var, httpOnly cookie)

**The roster grid is the whole admin UI.** Not a dashboard with an override dialog
buried in it — one tappable list that replaces the spreadsheet the admin used to
type into. Everything else hangs off it.

```
Soft Skills — 21 Aug          Session live · 12:14 remaining
                                              23 / 47 marked

  ✓  MT2026002  Ujalambkar Aditya Jayantrao      12:04
  ✓  MT2026008  Anmol Nayyar                     12:03
  ·  MT2026020  Dev Kumar                          —
  ✎  MT2026026  Gaurav Kumar                     manual
  ✓  MT2026028  Girish Vikram Chougule           12:07
```

`✓` scanned · `✎` marked by hand · `·` absent

- All 47 students always visible, ordered by `S.No`. Marks appear live as people
  scan (poll `/api/roster?s=` every 5s).
- **Tapping a row toggles that student.** Marked → unmarked, unmarked → marked.
  No modal, no confirm, no separate "override" mode. Undo is just tapping again.
- Reason is **optional** — after a tap, a small inline chip row offers
  *phone dead* / *late* / *correction*, dismissible. A mandatory reason field
  gets filled with junk by day three; the audit log captures who and when anyway.
- **Show QR** — expands the QR to fullscreen for projecting. The grid is the
  default view, the QR is the thing you open, not the reverse.
- Date picker loads any past session into the same grid, with identical tap
  behaviour. Corrections found a week later need no new interaction to learn.

Other admin controls, secondary to the grid:
- **Start Session** — `expires_at = now + 30 min`. Also **Start session for a past
  date** (see below).
- **Enrollment window** toggle (flips `settings.enrollment_open`).
- **Reset device** — clears a student's `device_id`, sets `reset_allowed = true`.
  For lost or wiped phones. Expect ~2 uses per semester.
- **End Session** and **Download roster .xlsx**.

### Backdated sessions

Required. The common failure is not a dead phone — it is the admin forgetting to
start a session at all and realising at 3pm. Without this there is no recovery
path, and a system with no recovery path gets abandoned.

- **Start session for a past date** creates a session with `is_open = false` and
  `class_date` set to the chosen day, so no QR is ever generated for it.
- It opens straight into the roster grid; the admin taps through from memory or a
  paper list. Every mark lands as `✎`.
- Reject a `class_date` that already has a session — offer to open that one instead.

### `POST /api/toggle { studentId, sessionId, reason? }`  (admin only)

One endpoint backs every tap.

- No `attendance` row → insert one with `source = 'manual'`.
- Row exists → delete it.
- Always write an `audit_log` entry (`OVERRIDE_MARK` / `OVERRIDE_UNMARK`) with the
  reason when given.
- Respond with the resulting state so the grid can update optimistically and
  reconcile.

Add `source text not null default 'scan'` to the `attendance` table. It drives the
`✓` vs `✎` distinction in the grid — **but the export writes plain `✓` for both**,
because the .xlsx must match the original layout exactly. If the provenance is ever
needed in the file, add a separate `Audit` sheet rather than altering the grid.

### Why the audit log is worth keeping

Not to police the admin — to protect them. When a student insists they attended on
the 14th and the record disagrees, the log settles it in one conversation.

## Permissions

No user table, no role system. Two cookies:

| | Identified by | Can do |
|---|---|---|
| **Admin** | `ADMIN_PASSWORD` → httpOnly session cookie | everything: sessions (live and backdated), enrollment window, device resets, toggling any student on any date, full roster export |
| **Student** | `att_device` localStorage UUID → server-side lookup | scan to mark self present, view own record, export own row |

Every write endpoint except `/api/mark` and `/api/enroll` checks the admin cookie
server-side. Never gate on anything the client sends.

### `GET /api/export`  → .xlsx  (admin only)

Must reproduce this layout exactly (matches the instructor's existing file):

| Col | Header | Content |
|-----|--------|---------|
| A | `S.No` | 1..47 |
| B | `Roll NO.` | roll_no |
| C | `Name ` | name (note trailing space in original) |
| D | `Mail Id` | email |
| E | `Date:` | label only, no data below |
| F–U | *a date per session* | `✓` where an attendance row exists, else blank |
| V | `Total \nAttendnacs` | `=COUNTIF(F2:U2,"✓")` |
| W | `Attendnacs \n%` | `=IF(COUNT($F$1:$U$1)=0,"",V2/COUNT($F$1:$U$1))` |

- Header row 1, students in rows 2–48.
- F1 onward = `sessions.class_date`, ascending, as real Excel dates.
- V and W must be **live formulas**, not computed values.
- Format W as `0.0%`.
- Font: Arial throughout.

## Build order

**Day 1**
1. `create-next-app`, Supabase project, run the schema.
2. Seed script for the 47 students.
3. Token generate + verify helpers — **unit test these first**, including the
   `w-1` acceptance and `w+1` rejection.
4. `/admin` roster grid + Start Session + the rotating QR.
5. `/m` + `/api/mark`, happy path only.

**Day 2**
6. Enrollment window, `/api/enroll`, device binding.
7. `/api/toggle` + audit log + reset device.
8. Backdated sessions and the date picker.
9. `/me` page.
10. `/api/export`, checked against the original file side by side.
11. Deploy to Vercel, set env vars.
12. Field test — see below.

## Test checklist

- [ ] Two phones scan simultaneously — both marked, no race on the unique key.
- [ ] Screenshot the QR, wait 40s, open it → rejected.
- [ ] Same student scans twice → still one row, no error shown to them.
- [ ] Incognito tab + someone else's roll number, enrollment **closed** → refused.
- [ ] Roll number already claimed, enrollment **open** → refused.
- [ ] Session expired → clear "scan again" message, not a stack trace.
- [ ] Export opens in Excel with V and W recalculating live.
- [ ] Airplane mode mid-scan → sane error, no silent failure.
- [ ] `/api/export` and `/api/toggle` called without the admin cookie → 401.
- [ ] Student on `/me` sees only their own row, never anyone else's.
- [ ] Tap a scanned student → unmarked; tap again → marked as `✎`, two audit entries.
- [ ] Backdated session created for a date with no QR → grid loads, taps work,
      no token is ever generated for it.
- [ ] Backdated session for a date that already has one → refused, offers the existing.
- [ ] Export shows plain `✓` for both scanned and manual marks.

## Env vars

```
NEXT_PUBLIC_SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY     # server-side only, never exposed to client
ADMIN_PASSWORD
```

## Deliberately out of scope

Multi-class support, faculty accounts, geofencing, face recognition, native apps,
and any AI/LLM component. Every rule here is deterministic — adding a model would
add latency and failure modes for no benefit.

**Also deliberately excluded: live sync to a OneDrive/Google Sheets file.** It was
considered and rejected. It requires an Entra app registration, an OAuth consent
flow, encrypted refresh-token storage, and write-conflict handling — and it fails
silently when a token goes stale. On-demand export from Postgres gives the same
artifact with none of that. If it is ever wanted, it bolts on cleanly, because
Postgres is already the source of truth.
