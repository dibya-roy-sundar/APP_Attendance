# Testing and coverage

What is covered, what each engine can and cannot prove, and which suites will destroy your data.

[← back to the README](../README.md)

## What is covered

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
[`test/local/db.mjs`](../test/local/db.mjs).

**Before a class, export the register.** There are no database backups on the
Supabase free tier, so the spreadsheet is the backup.

### Theme

Light, Dark and Auto, offered on the home page, on `/me`, and under **More** on
the admin page. **Dark is the default**; change `DEFAULT_MODE` in
[`src/lib/theme.ts`](../src/lib/theme.ts) to `'system'` to follow each device's own
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
npm run e2e:mobile              # 509 checks across six phone sizes, both themes
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

### Which engine proves what

Not every suite can reach every layer, and the gaps are worth stating rather than
leaving to be assumed from a green summary.

| | Chromium | WebKit / iOS | Real handset |
|---|---|---|---|
| Layout, contrast, tap targets | ✅ mobile audit | ✅ mobile audit | — |
| Admin session, QR, grid, export | ✅ | ✅ | — |
| Scan screen when the prompt fails | ✅ | ✅ | — |
| Registering and signing in with a passkey | ✅ virtual authenticator | ❌ **impossible** | — |
| `excludeCredentials` refusal | ✅ | ❌ **impossible** | ❌ **not done** |
| Synced passkey following an account | ❌ | ❌ | ❌ **not done** |

The two "impossible" rows are not laziness. Playwright's virtual authenticator is
a Chrome DevTools Protocol feature; WebKit has no equivalent, so no credential
can exist there and the ceremony cannot run. The bottom row cannot be tested by
any harness, because a virtual authenticator has no account to sync through.

So: **everything about how a passkey behaves on an iPhone is currently an
inference** from Chromium plus the specification. The screen's behaviour around a
failed prompt is not — that is checked on both engines, and it is where the
reported bug actually lived.

### End-to-end, against a real database

The build spec's test checklist is automated — 239 checks covering token
rotation, enrolment races, concurrent scans, backdated sessions, `/me` isolation,
the audit log, and the export.

Point it at any running instance plus that instance's database:

```bash
set -a; . ./.env.local; set +a      # or your staging env
npm run build
npm run e2e:serve &                 # serves on :3100
npm run e2e
```

Override `BASE_URL` to test a deployed instance instead of localhost.

**It deletes data.** Every run clears `sessions`, `attendance`, `audit_log` and
every passkey, so run it against a scratch project or before the term
starts — never against a database holding real attendance. As a safeguard it
refuses to start if `attendance` already has rows; pass `E2E_CONFIRM_WIPE=1` to
override that deliberately.

There is also a self-contained Docker stack (`npm run e2e:up` / `e2e:down`) that
runs Postgres and PostgREST locally, for testing without a Supabase project.
