# QR Attendance

A class attendance system. The instructor projects a QR code that rotates on a
period they choose — 5 to 300 seconds, 15 by default; students scan it with their
phone and are marked present for that date. The instructor can download an
`.xlsx` matching their existing sheet layout exactly.

No email, no student passwords. Identity is a **passkey**: a private key held by
the phone's credential store, confirmed with a face or a fingerprint, which the
OS carries to a new phone by itself. Nothing to reset when a student clears their
browser data. The one case that still needs a person — a genuinely lost phone —
goes through an approval queue rather than a reset button, for reasons under
[Lost or wiped phone](docs/running-a-class.md#lost-or-wiped-phone).

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
touches a passkey, so you can re-run it after fixing a name in the sheet.

### 4. Run

```bash
npm run dev
```

## Running a class

1. `/admin`, sign in with the password.
2. **Start session** — pick how long attendance stays open and how fast the QR
   rotates. **Use 10 seconds for a real class**; the rotation period is the only
   real control over someone relaying the code to an absent friend.
3. **Show QR** and project it. Project it *large* — a fast rotation is
   unforgiving of a code nobody at the back can read.
4. Students scan, tap once, confirm with a face or fingerprint. The grid fills in
   live, polling every five seconds.
5. Anyone whose phone is dead: tap them on the grid. That lands as a manual mark
   with your name against it, and works whether or not a session is open.
6. **Download .xlsx** when you want the register.

Then the check no cryptography can do for you: **compare the count on the grid
against the number of occupied seats.**

Details — the grid, the panels, deputies, exports, late joiners — in
[Running a class](docs/running-a-class.md).

## How it works

Three layers, and it is worth knowing which does what:

| | What it is | Can it mark you present? |
|---|---|---|
| **Roll number** | Typed once, ever. A *label* that says which student a new passkey belongs to. | No |
| **Passkey** | The identity. Lives in the phone's credential store, needs a face or fingerprint. | Yes, with a live QR token |
| **Session cookie** | Disposable convenience, so `/me` can be read without a biometric prompt. Regenerated in ~175 ms. | **No** |

The rule that shape follows: **bearer tokens read, signatures write.** The cookie
is copyable, and that is accepted, because all it can do is show one student their
own percentage. Recording attendance always needs a fresh signature *and* a live
token.

Diagrams for each flow, the data model, and fifteen numbered decisions with their
reasoning: [Architecture](docs/architecture.md).

## What stops attendance being faked

Two independent proofs, neither substituting for the other:

- **Who** — a passkey signature over a server-issued, single-use challenge.
- **Where** — a token from the projected QR, valid for one rotation period.

On top of that: one passkey per student, enforced by a unique index rather than
by checking first; one passkey per keychain, enforced by the phone refusing to
make a second; and a claim on an already-enrolled roll number becomes a request
for you to approve rather than something the server decides.

**What is not solved, and knowingly so:**

- **Relaying the QR** to an absent friend who signs in as themselves. No identity
  system fixes this. Rotation speed is the only lever.
- **Claiming a roll number nobody has enrolled yet**, most easily from a
  private-browsing window. Accepted on 2026-08-25 with the reasoning recorded —
  it is deliberate, bounded to absent students, locks the real student out so it
  surfaces when they return, and every fix costs you time in every class.

Both are written up honestly, along with the vulnerability that reshaped the
design and how it was found: [Security](docs/security.md).

## Documentation

The README is the short version. Each of these is the long one for its own
subject.

| | What is in it |
|---|---|
| [Architecture](docs/architecture.md) | Component and data-model diagrams, activity diagrams for both enrolment paths, four sequence diagrams, and the fifteen numbered decisions with the why for each |
| [Security](docs/security.md) | The rotating token, what the cookies can and cannot do, throttling, RLS, the audit log — and **One phone, many roll numbers**, the vulnerability that changed the design, how it was reproduced, and what is still accepted |
| [Identity, and how it got here](docs/identity.md) | Four designs, three replaced: localStorage UUID → httpOnly cookie → passkeys → one per student. Why Microsoft SSO and email OTP were both rejected. What "the key never leaves the phone" actually means, and where a passkey really lives |
| [Running a class](docs/running-a-class.md) | The grid, staged marking, the phone-changes panel, deputy access, exports, late joiners, roster caching, and the Vercel region that made sign-in 9× faster |
| [Testing](docs/testing.md) | 997 checks across five suites, which engine can prove which layer, and a loud warning about the suites that delete real data |
| [`docs/superseded/`](docs/superseded/) | Code that was replaced, kept with an index explaining what each file was and why it went |

## Deliberately out of scope

Multi-class support, faculty accounts, geofencing, face recognition, native apps,
and any AI/LLM component — every rule here is deterministic, so a model would add
latency and failure modes for no benefit.

**Live sync to a OneDrive/Google Sheets file** was considered and rejected: it
needs an app registration, an OAuth consent flow, encrypted refresh-token
storage, and write-conflict handling, and it fails silently when a token goes
stale. On-demand export gives the same artifact with none of that, and bolts on
cleanly later because Postgres is already the source of truth.
