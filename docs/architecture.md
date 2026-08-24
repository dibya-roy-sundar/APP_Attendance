# Architecture and flows

The shape of the system, the data model, the flows through it, and the numbered decisions behind them.

[← back to the README](../README.md)

## The shape of the system

Three actors, one server, one database. The projector and the phone never talk to
each other over the network — the QR is the only channel between them, and that
is the point: it cannot be relayed without being re-photographed.

```mermaid
flowchart LR
  subgraph hall["Lecture hall"]
    direction TB
    proj["Projector<br/>rotating QR<br/>carries s and t"]
    sp["Student phone<br/>private key in<br/>OS keychain"]
    ip["Instructor phone<br/>/admin"]
  end

  subgraph vercel["Vercel · Fluid Compute · region bom1"]
    direction TB
    pages["/m and /me<br/>student screens"]
    admin["/admin<br/>grid, QR, export"]
    pk["/api/passkey/*<br/>options and verify"]
    rest["/api/token · /api/marks<br/>/api/roster · /api/export"]
  end

  db[("Supabase Postgres<br/>region bom1<br/>RLS on, no policies")]

  proj -. "camera, once per class" .-> sp
  sp -->|"assertion + live token"| pages
  pages --> pk
  ip -->|"password or access code"| admin
  admin --> rest
  pk -->|"service role"| db
  rest -->|"service role"| db
```

Everything server-side talks to Postgres with the service role key and RLS is on
with **no policies**, so a leaked anon key grants nothing. There is no auth
library and no session table: the admin cookie and the student cookie are both
self-describing and HMAC-signed, so a request needs one database read fewer.

### Data model

```mermaid
erDiagram
  students ||--o| student_credentials : "exactly one passkey"
  students ||--o{ attendance : "present at"
  sessions ||--o{ attendance : "records"
  students ||--o{ passkey_requests : "claims awaiting a decision"
  sessions ||--o{ passkey_requests : "raised during"
  students ||--o{ webauthn_challenges : "register only, else null"
  students ||--o{ audit_log : "subject of"
  sessions ||--o{ audit_log : "subject of"

  students {
    uuid id PK
    int s_no UK "the instructor's sheet order"
    text roll_no UK
    text name
  }
  sessions {
    uuid id PK
    date class_date UK "one session per day"
    text secret "HMAC key for the QR"
    bool is_open
    timestamptz expires_at
    int window_seconds "5 to 300"
  }
  attendance {
    uuid session_id PK
    uuid student_id PK
    timestamptz marked_at
    text source "scan or manual"
  }
  student_credentials {
    uuid id PK
    uuid student_id UK "one per student"
    text credential_id UK "which key"
    text public_key "verifies the signature"
    bigint counter "must advance"
  }
  passkey_requests {
    uuid id PK
    uuid student_id "one pending per student"
    text decision "approved, rejected, or null"
  }
  audit_log {
    bigint id PK
    text action
    text actor "primary, deputy:label, or student"
  }
```

Three constraints do work that application code would otherwise have to
remember, and would get wrong under concurrency:

- `attendance` is keyed on `(session_id, student_id)`, so double-marking is not
  something to guard against — it is not expressible.
- `sessions.class_date` is `unique`, so two admins tapping **Start** at the same
  moment produce one session, not two.
- `student_credentials` has a unique index on `student_id`, so three simultaneous
  claims on one roll number produce one credential. A check-then-insert has a
  window here, and it was measured letting **two of three** through.

## How it flows

The first two diagrams are the **decision logic** — every check, in the order the
server applies it, and what each refusal returns. The four after them are
**sequences**, which answer a different question: who talks to whom, how many
round trips it costs, and where the boundary between the browser and the OS
keychain falls. Same flows, deliberately different cross-sections.

### Marking present, when the phone already has a passkey

The ordinary case, and the one that happens 46 times out of 47. Two round trips,
because WebAuthn needs a challenge before the biometric and a signature after it.
Each refusal carries the code the screen has copy for.

```mermaid
flowchart TD
  start(["/m opens with s and t from the QR"]) --> tap["Student taps Mark me present"]
  tap --> opts["POST auth/options"]
  opts --> live{"Session open<br/>and not expired?"}
  live -- "no · SESSION_CLOSED" --> refused
  live -- yes --> tok{"Token valid for<br/>window w or w-1?"}
  tok -- "no · BAD_TOKEN" --> refused
  tok -- yes --> bio["Challenge stored, single use,<br/>then face or fingerprint"]
  bio --> verify["POST auth/verify"]
  verify --> spent{"Challenge<br/>still unspent?"}
  spent -- "no · CHALLENGE_EXPIRED" --> refused
  spent -- yes --> known{"Credential id<br/>known?"}
  known -- "no · UNKNOWN_PASSKEY" --> reg(["Registration, below"]):::warn
  known -- yes --> sig{"Signature valid, and<br/>counter advanced?"}
  sig -- "no · BAD_ASSERTION" --> refused
  sig -- yes --> mark["UPSERT attendance source scan<br/>Set-Cookie att_student"]
  mark --> done(["Present"]):::good
  refused(["Refused. Nothing written."]):::bad

  classDef bad fill:#fde,stroke:#c33,color:#300
  classDef warn fill:#ffe9c7,stroke:#c80,color:#310
  classDef good fill:#dfe,stroke:#2a2,color:#030
```

Note what this does **not** contain: any path where typing a roll number alone
marks somebody present, and any path from the cookie to the `attendance` table.
Both are deliberate — see decision 5, **Bearer tokens read, signatures write**.

### Getting a passkey in the first place

Reached only by a deliberate tap after a failed prompt — never as the place a
cancelled fingerprint dialog lands you, which is the bug this shape exists to
prevent. The roll number is asked for exactly once in the term.

Three of these gates were added after one phone was found collecting passkeys for
classmates who had not enrolled: the local flag, the authenticator's exclusion
check, and the signed-in-as-someone-else check. The fork at the bottom is the
older argument and still the main one — claiming an *unclaimed* roll number needs
only presence, claiming one that is already taken needs a person.

```mermaid
flowchart TD
  a(["Not confirmed · the student taps<br/>I have not set up this phone yet"]) --> flag{"Does this browser think<br/>the phone is enrolled?"}
  flag -- yes --> hide(["The form is never shown"]):::bad
  flag -- no --> opts["POST register/options<br/>with the roll number"]
  opts --> gate{"Session live and<br/>token still valid?"}
  gate -- no --> refused
  gate -- yes --> excl{"Does this phone already hold<br/>ANY classmate's passkey?"}
  excl -- "yes · InvalidStateError,<br/>the authenticator refuses" --> refused
  excl -- no --> create["OS creates a keypair.<br/>Only the public half is sent."]
  create --> verify["POST register/verify"]
  verify --> att{"Attestation, origin<br/>and RP ID all valid?"}
  att -- "no · BAD_ATTESTATION" --> refused
  att -- yes --> other{"Is this browser signed in<br/>as a different student?"}
  other -- yes --> queue
  other -- no --> taken{"Does that roll number<br/>already hold a passkey?"}
  taken -- "yes, and you cannot prove<br/>the old phone is yours" --> queue
  taken -- no --> ins["INSERT student_credentials"]
  ins --> race{"Won the race to<br/>the unique index?"}
  race -- "no · a simultaneous claim" --> queue
  race -- yes --> mark["UPSERT attendance, set cookie"]
  mark --> done(["Present"]):::good
  queue["Row in passkey_requests<br/>409 NEEDS_APPROVAL"]:::warn --> wait(["The instructor decides.<br/>Nobody is marked meanwhile."]):::warn
  refused(["Refused"]):::bad

  classDef bad fill:#fde,stroke:#c33,color:#300
  classDef warn fill:#ffe9c7,stroke:#c80,color:#310
  classDef good fill:#dfe,stroke:#2a2,color:#030
```

### A student's first class

Now the same journey as a sequence, because the interesting part is not the
branching but the **two round trips and the keychain boundary** — where the
keypair is made, and what crosses back to the server.

The roll number is typed exactly once in the term, and it is a *label*, not a
key. The phone generates the identity; the roll number only decides which
`student_id` gets written into the passkey.

```mermaid
sequenceDiagram
  autonumber
  actor S as Student
  participant B as Phone browser
  participant K as OS keychain
  participant V as Vercel
  participant P as Postgres

  S->>B: scans the projected QR
  B->>V: GET /m with s and t
  S->>B: taps Mark me present
  B->>V: POST auth/options
  V->>P: session live? token valid?
  V->>P: INSERT challenge, purpose authenticate
  V-->>B: challenge
  B->>K: credentials.get
  K-->>B: nothing for this site
  B-->>S: Set up this phone — roll number please
  S->>B: MT2026520
  B->>V: POST register/options with the roll number
  V->>P: INSERT challenge, purpose register, student_id set
  V-->>B: challenge and excludeCredentials
  B->>K: credentials.create
  Note over K: keypair in the credential store.<br/>Only the public half is sent.
  K-->>B: public key and attestation
  B->>V: POST register/verify
  V->>P: DELETE challenge RETURNING — single use
  V->>V: check attestation, origin, RP ID
  V->>P: INSERT student_credentials
  V->>P: UPSERT attendance, source scan
  V-->>B: att_student cookie, Present
  B-->>S: Present
```

### Every later class

Nothing is typed, and the roll number is never sent again. The passkey is
discoverable, so its `userHandle` tells the server who signed — which is also why
`allowCredentials` is empty and this endpoint leaks nothing about who is enrolled.

```mermaid
sequenceDiagram
  autonumber
  actor S as Student
  participant B as Phone browser
  participant K as OS keychain
  participant V as Vercel
  participant P as Postgres

  S->>B: scans the QR, taps Mark me present
  B->>V: POST auth/options
  V->>P: session live? token valid for w or w-1?
  V->>P: INSERT challenge
  V-->>B: challenge
  B->>K: credentials.get, allowCredentials empty
  K-->>S: face or fingerprint
  S-->>K: confirms
  K-->>B: signature over the challenge
  B->>V: POST auth/verify
  V->>P: DELETE challenge RETURNING
  V->>P: SELECT credential by id
  V->>V: verify signature, then counter must advance
  V->>P: UPDATE counter and last_used_at
  V->>P: UPSERT attendance, source scan
  V-->>B: att_student cookie, Present
  Note over V,P: sweepChallenges runs after the response,<br/>so the DELETE of lapsed rows costs the student nothing
```

### A contested roll number

The case that reshaped the design. A stranger in the room holding the live QR
types a classmate's roll number. The server cannot tell that apart from the
classmate's own new phone, so it stops guessing and asks a human.

```mermaid
sequenceDiagram
  autonumber
  actor X as Someone in the room
  participant B as Their phone
  participant V as Vercel
  participant P as Postgres
  actor A as Instructor

  X->>B: enters MT2026520, not their own
  B->>V: POST register/options then register/verify
  V->>V: attestation verifies — the credential is valid
  Note over V: valid is not the same as trusted
  V->>P: SELECT credentials for that student — one exists
  V->>P: INSERT passkey_requests, with device and time
  V->>P: INSERT audit_log PASSKEY_REQUESTED, actor student
  V-->>B: 409 NEEDS_APPROVAL
  B-->>X: Waiting for the instructor
  Note over V,P: nobody was marked present,<br/>and the original passkey is untouched

  A->>V: opens More, Phone changes
  V->>P: SELECT last 7 days, any status
  V-->>A: the claim, its device and time
  A->>A: asks that student to come to the front
  alt genuinely their new phone
    A->>V: Approve
    V->>P: replace the credential, still one per student
    V->>P: audit_log PASSKEY_APPROVED, actor primary
  else nobody comes forward
    A->>V: Refuse
    V->>P: mark rejected, keep the row as evidence
    V->>P: audit_log PASSKEY_REJECTED, actor primary
  end
```

### The instructor running a class

```mermaid
sequenceDiagram
  autonumber
  actor A as Instructor
  participant B as Browser
  participant V as Vercel
  participant P as Postgres

  A->>B: password or access code
  B->>V: POST /api/admin/login
  V->>P: on failure, INSERT login_attempts — ten in fifteen minutes is 429
  V-->>B: att_admin cookie, HMAC signed, no session row
  A->>B: Start session, 45 min, QR every 10 s
  B->>V: POST /api/sessions
  V->>P: INSERT sessions with a fresh 32-byte secret
  Note over P: class_date is unique — two admins tapping Start give one session
  loop every window, driven by refreshInMs
    B->>V: GET /api/token
    V-->>B: 12-char token and scanUrl, never the secret
    B->>B: redraw the QR
  end
  loop every 5 s
    B->>V: GET /api/roster
    V-->>B: the grid, scans appearing live
  end
  A->>B: taps a student whose phone is dead
  B->>V: POST /api/marks
  V->>P: UPSERT attendance, source manual
  V->>P: audit_log OVERRIDE_MARK, one row per student, with actor
  A->>B: Extend / stop
  B->>V: POST /api/sessions/state
  Note over P: only is_open and expires_at move.<br/>opened_at stays as the record of when the class began
  A->>B: Download .xlsx
  B->>V: GET /api/export
  V->>P: audit_log EXPORT with actor
```

Marking by hand is deliberately **not** gated on the session being open: the grid
has to stay editable after class, and a backdated session is created closed so it
never has a QR at all. Scanning is gated on all three of a live session, a live
token and a signature.

## Architectural decisions

The reasoning behind each of these is in the sections below; this is the index.
Every one was either measured or arrived at by breaking the previous version.

| # | Decision | Why | Where |
|---|---|---|---|
| 1 | **Postgres is the source of truth.** Excel is generated on demand, never written to at runtime. | A spreadsheet cannot be read concurrently by 47 phones, and a file that is both input and output has no answer for "which copy is right". | [Export](running-a-class.md#export) |
| 2 | **No auth library.** The admin is one password in an env var; both cookies are self-describing and HMAC-signed. | There is one admin and no sign-up, no reset, no roles beyond deputy. A library would add a dependency and a session table to solve problems this app does not have. | [Cookies and HTTPS](security.md#cookies-and-https) |
| 3 | **Identity is a passkey**, after a localStorage UUID and then an httpOnly cookie. | Both predecessors were bearer tokens — copyable, forwardable, and destroyable by Safari's 7-day cap. A passkey cannot be read by a page or handed to a friend, and using it needs the device unlock. | [Why identity moved…](identity.md#why-identity-moved-from-localstorage-to-a-cookie-to-passkeys) · [What "the key never leaves the phone" actually means](identity.md#what-the-key-never-leaves-the-phone-actually-means) |
| 4 | **Two independent proofs to be marked present:** *who* is a signature, *where* is a live rotating token. | Neither substitutes for the other. A passkey off campus proves identity but not presence; a photographed QR proves presence but not identity. | [Identity](security.md#identity) |
| 5 | **Bearer tokens read, signatures write.** The `att_student` cookie can fetch `/me` and nothing else. | The cookie is copyable and a friend *can* paste it — accepted, because its whole power is reading one student's own percentage. Attendance always needs a fresh assertion. | [Identity](security.md#identity) |
| 6 | **One passkey per student, enforced by a unique index** rather than by checking first. | Postgres has no race window; check-then-insert does, and it let two of three simultaneous claims through when tested. | [Guarding the credentials](security.md#guarding-the-credentials) |
| 7 | **An approval queue, not a reset button.** | A lost phone and a stranger's phone are indistinguishable to the server. So a person decides, and every refused claim becomes evidence with a device and a time on it. | [Lost or wiped phone](running-a-class.md#lost-or-wiped-phone) |
| 8 | **The queue shows facts, not guesses.** No "already marked today", no "old phone last used". | Neither discriminates: a proxy attempt happens while the student is absent, and so does a genuine lost phone. A hint that only fires in the rare case invites trusting it instead of asking the student. | [The phone-changes panel](running-a-class.md#the-phone-changes-panel) |
| 9 | **Registration is authorised by presence**, not by an admin-controlled window. **Partly wrong** — the window was removed on reasoning that did not hold, and the gap it left is still open. | Holding a live QR token does mean being in the room, and that part stands. But the case the window defended was called "self-correcting" when it is not: the victim is marked *present*, so nobody complains and nothing surfaces. | [Registration, and the window that was wrong to remove](security.md#registration-and-the-window-that-was-wrong-to-remove) |
| 17 | **The private-browsing enrolment route is accepted, not fixed.** No enrolment gate. | Every remaining fix costs the instructor time in every class, or an email pipeline, against an attack that is deliberate, limited to roll numbers nobody has enrolled, self-revealing when the real student tries to enrol, and committed in a room with the instructor in it. Detection is proportionate here; prevention is not. Decided 2026-08-25. | [What is accepted, and why](security.md#what-is-accepted-and-why) |
| 16 | **One passkey per device**, via `excludeCredentials` carrying the whole class. | `UNIQUE(student_id)` gave one passkey per student and nothing gave one per device, so a single handset could collect a passkey for every unenrolled classmate and mark them present all term. Enforced by the authenticator, so it stops a phone and not a script. | [One phone, many roll numbers](security.md#one-phone-many-roll-numbers) |
| 10 | **Housekeeping runs behind the response** via `after()`, with no cron. | Both swept tables are self-limiting by query, so the deletes are tidying, not correctness — and have no business costing a student a round trip. One less thing that can silently stop running. | [The phone-changes panel](running-a-class.md#the-phone-changes-panel) |
| 11 | **RLS on with no policies.** Every server query uses the service role. | A leaked anon key then grants nothing at all, rather than whatever the policies happen to permit. | [Permissions](security.md#permissions) |
| 12 | **The roster is cached in memory for 30 seconds**, and any write clears it. | Read on nearly every request, changed a handful of times a term. Thirty seconds and not thirty minutes because several serverless instances cannot tell each other about a new student. | [Caching](running-a-class.md#caching) |
| 13 | **The function region is pinned next to the database.** | Left at the default, compute ran in Washington against a database in Mumbai: nine sequential round trips made sign-in 2800 ms. Pinning it to `bom1` took that to 305 ms. | [Function region](running-a-class.md#function-region) |
| 14 | **The audit log records human decisions, not scans.** | 47 scans a class would bury the six overrides that someone might actually have to justify. The `attendance` row with `source = 'scan'` is the record of a scan. | [The audit log](security.md#the-audit-log) |
| 15 | **QR rotation speed is the only real control over relaying.** | No identity mechanism stops a student photographing the QR for an absent friend who then signs with their own face. Ten seconds gives a 10–20 s usable window against a 15–30 s realistic relay. | [What none of this fixes](identity.md#what-none-of-this-fixes) |
