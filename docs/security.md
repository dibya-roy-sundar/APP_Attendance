# Security

What stops attendance being faked, what does not, and the reasoning for each — including the vulnerability that reshaped the design.

[← back to the README](../README.md)

## Registration, and the window that was wrong to remove

A phone with no passkey can be offered registration. There used to be an
admin-controlled window; it was removed, and the reasoning for removing it was
wrong. Both halves are recorded here because the mistake is more instructive than
the fix.

**What the README used to say:** the window "only ever defended against somebody
claiming an **unclaimed** roll number unilaterally, and that case is
self-correcting: the real student is told the number is taken and the admin sorts
it out."

**Why that is wrong:** the victim is marked **present**. They have no reason to
complain. The attacker has no reason to complain. If the victim ever does try to
enrol, they land in the approval queue looking exactly like an ordinary lost
phone. Nobody is unhappy, so nothing surfaces — it is a stable state, not a
self-correcting one. "Self-correcting" assumed the harm was visible to the person
harmed, and it is not.

What authorises registration is **presence**: creating a passkey requires a live
QR token, which only exists on the projector in the room. That part still holds,
and it is why enrolling needs no admin and no email.

## One phone, many roll numbers

The hole that reasoning left open, found in production by cancelling a
fingerprint prompt.

Cancelling led to the enrolment form. That is not a slip so much as an
unavoidable ambiguity — WebAuthn will not tell a page whether a passkey exists,
so a cancelled prompt and an empty keychain are the same event — but this screen
resolved the ambiguity by offering the form, which handed it to anybody. Enter a
classmate's roll number and their passkey is created on your phone.

**`UNIQUE(student_id)` guaranteed one passkey per student. Nothing guaranteed one
passkey per device.** Reproduced before fixing, on one handset:

```
their own roll number registers                            ok
MT2026008 claimed from the same phone                      ok
MT2026020 claimed from the same phone                      ok
MT2026026 claimed from the same phone                      ok
MT2026028 claimed from the same phone                      ok
five passkeys now exist, all on one device                 ok
nothing is waiting in the approval queue                   ok
```

Then, with the attendance cleared and the keychain untouched — next week:

```
all five present, one device, nothing typed                ok
```

So it was not one roll number and not one class. One phone could hold a passkey
for every student who had not enrolled yet and mark them present for the rest of
the term, needing nothing from those students ever again.

An edge test had asserted this **as a feature** — "one phone may register a
second student … a shared family phone, or the admin's own phone". That is the
second time in this project a test encoded a vulnerability as intended
behaviour. Both times the test was written from the same reasoning as the code,
which is exactly when a test is worth least.

#### The fix, in three layers

**1. The authenticator refuses.** `excludeCredentials` now carries *every*
credential in the class, not only the roll number being claimed. A phone already
holding any classmate's passkey cannot create a second one — it throws
`InvalidStateError` before the server is involved. Verified against Chromium's
real WebAuthn implementation, not only the software authenticator in the suites:

```
the exclusion list carries the whole class, not just the roll number asked for  ok
a real authenticator refuses a second passkey on the same phone                 ok
the keychain still holds exactly one credential                                 ok
```

This is enforced by the phone. A caller scripting WebAuthn by hand can drop the
list, and the server cannot detect it: a platform authenticator reports no device
identity by design, and the AAGUID names a model rather than a handset. So this
stops a student with a phone, which is the threat here, and does not stop someone
writing their own client.

**Verified on Chromium only, and it cannot be otherwise in CI.** Playwright's
virtual authenticator is a Chrome DevTools Protocol feature, so WebKit has no way
to hold a credential and the registration ceremony is unreachable there. Every
statement about iPhone behaviour in this section is therefore an inference from
Chromium plus the specification. **It wants confirming on a real iPhone**, and it
is the single most valuable thing left to test by hand.

**2. The screen stops guessing.** A failed prompt now says "Not confirmed" and
offers **Try again**. Enrolment is a separate, deliberate tap, and it is not
offered at all when a local flag says this phone has already been enrolled. The
flag is clearable, so it is an affordance rather than a control — its job is to
stop a cancelled prompt from *handing over* the form.

This layer needs no authenticator, so unlike layer 1 it **is** checked on WebKit
as well as Chromium — eight assertions per engine, on the iPhone 14 and Pixel 7
presets. That matters, because until it was added the scan screen had never once
been rendered in WebKit by any suite: the whole passkey journey was Chromium-only
and every claim about Safari was an inference.

One measured difference between the engines, and the reason not to build on it:
with no authenticator attached, `navigator.credentials.get()` rejects with
**`NotAllowedError` on WebKit** and **`NotSupportedError` on Chromium**. The
client catches any exception rather than matching on the name, so both behave
identically. Matching on names here would have produced a bug on exactly one
platform.

**3. The server queues cross-student claims.** Enrolling a roll number from a
browser that already holds a session for a *different* student is never the
innocent first-time case, whatever else it is. It goes to the approval queue with
an audit line saying so, rather than being written. This catches the scripted
caller from layer 1 — as long as it keeps its cookie.

#### What is accepted, and why

A caller with **no cookie, no real authenticator, and a roll number nobody has
enrolled** can still claim it. Proved, deliberately, so it is not a surprise:

```
claiming a third roll number: 200 REGISTERED
^ THIS IS THE RESIDUAL GAP
```

**A private-browsing window is the easy way in, and this was understated here
before.** It was described as needing "a second physical device: a laptop or an
old phone" — as though it took equipment. It does not. Confirmed on a real phone:
in a Chrome incognito window, cancel the prompt, enter an unenrolled roll number,
and a passkey is created and that student is marked present.

All three layers fail at once, and for one reason: **every one of them keys off
device state, and private browsing is designed to present as a new device.**

| Layer | Why it does not fire in private browsing |
|---|---|
| `excludeCredentials` → `InvalidStateError` | The window does not surface the profile's saved passkeys to the page, so the authenticator has nothing to match the exclusion list against. It sees an empty keychain. |
| The local `att_enrolled` flag | Fresh `localStorage`, so nothing says this phone is enrolled and the enrol button is offered — correctly, by its own logic. |
| Session cookie naming another student | No cookies carry over, so there is no cross-student claim to catch. |

This is not a defect in any of the three. It is the shape of the problem: nothing
observable from the browser can distinguish "a student's first phone" from "the
same student's phone pretending to be new", because the browser is deliberately
built to make those identical. Only something the *server* controls can tell them
apart, and the only such thing here is whether enrolment is open at all.

The same applies, less conveniently, to a second physical device or a script.

Only gating first-time enrolment closes this. Two shapes were designed and
costed:

- **An enrolment window on the session** — a toggle, default closed, with
  unenrolled roll numbers going to the approval queue while it is shut. Leaves one
  supervised hour of exposure instead of a whole term.
- **Approve every first enrolment** — no window at all, at the cost of roughly 47
  approvals during the first class.

**Neither is implemented, and that is a decision rather than a gap in the
backlog.** Taken on 2026-08-25, after the private-browsing route was confirmed on
a real phone: the residual risk is accepted and the app ships without an enrolment
gate.

The reasoning, so it can be revisited rather than rediscovered:

- The exposure needs somebody to deliberately open a private window, cancel a
  biometric prompt, and type a classmate's roll number. That is not a mistake
  anybody makes; it is a decision to commit fraud, in a room with the instructor
  in it.
- It only works on roll numbers **nobody has enrolled**, which after the first
  class means absent students — and it locks the real student out, so it surfaces
  the moment they try to enrol.
- The controls that remain are proportionate to a class of 47 with the instructor
  physically present, and they cost nothing:
  - `audit_log` records every `PASSKEY_REGISTERED` with a time and a device label,
    so the enrolment list can be checked against who was in the room.
  - The grid reports how many students have enrolled, so an enrolment appearing in
    week six is visible.
  - A hijacked roll number locks its owner out, and their claim lands in the
    approval queue with the original device's details beside it.
  - The count on the grid against the number of occupied seats catches the whole
    class of proxy attempts, this one included.

What tipped it: every remaining fix costs the instructor real time in every class
— or an email pipeline — to defend against an attack that is deliberate, bounded
to absent students, self-revealing when the victim returns, and committed in front
of the person keeping the register. **Revisit this if the roster grows past a size
one person can see, or if the register ever carries consequences worth committing
fraud for.**

One thing does make the private-browsing route noisier than it looks. Whatever it
enrols, our `student_credentials` row persists — so that roll number is now taken,
and the real student is locked out and has to go through the approval queue. If
they ever try to enrol, it surfaces. If they are absent all term, it does not.

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

A **passkey**. The private key is held in the phone's credential store, and no
web page can read it — so unlike every earlier version of this, identity is not a
bearer token that can be copied or forwarded. What that does and does not
guarantee is set out in
[What "the key never leaves the phone" actually means](identity.md#what-the-key-never-leaves-the-phone-actually-means).

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
