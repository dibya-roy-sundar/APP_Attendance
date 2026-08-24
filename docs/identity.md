# Identity, and how it got here

Four designs in, three replaced. What each one failed at, why Microsoft SSO and email OTP were both rejected, and what a passkey actually guarantees.

[← back to the README](../README.md)

## Why identity moved from localStorage, to a cookie, to passkeys

This changed three times. Each step was forced by a specific failure, and the
alternatives that look obvious were each rejected for a concrete reason. The
superseded code is preserved under [`docs/superseded/`](superseded/).

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

And it is the first version that is not a bearer token: no page can read the
private key, a student cannot hand it over the way they could hand over a cookie,
and using it needs the device unlock. See
[What "the key never leaves the phone" actually means](#what-the-key-never-leaves-the-phone-actually-means)
for the precise version of that claim, which is weaker than it is usually
written.

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

**Claiming a roll number nobody has enrolled.** A device with an empty keychain
can enrol one unclaimed roll number while a session is live, and is then marked
present as that student. The easiest route is a private-browsing window, which
presents as a new device by design. One phone can no longer collect several, and a
normal window that has already enrolled cannot enrol another at all, but the first
claim on an unclaimed number is not gated — and, as of 2026-08-25, deliberately
will not be. See [What is accepted, and why](security.md#what-is-accepted-and-why) for the
reasoning and the detection that stands in its place.

In practice: **the first class of the term is the exposure**, because that is when
every roll number is unclaimed. Check the enrolment list against who was in the
room.

### What "the key never leaves the phone" actually means

This README said, in seven places, that the private key is generated in the
secure element and cannot be extracted. That is the usual phrasing, and it is
wrong for the kind of passkey nearly every student will have.

**Device-bound** passkeys and hardware security keys are genuinely fused to one
piece of hardware. **Synced** passkeys — Google Password Manager, iCloud
Keychain — are not, and cannot be: a key that turns up on your new phone by
itself was never locked to the old one's silicon. That syncing is exactly the
property this design was chosen for, so the strong claim and the useful behaviour
were never compatible.

What actually holds for a synced passkey, and what this app relies on:

- **No web page can read it.** There is no API that returns private key material,
  so a compromised or hostile page cannot lift it.
- **A student cannot hand it over.** Not the way they could paste a cookie or read
  out a localStorage UUID. It moves only inside the provider's end-to-end
  encrypted sync, between devices signed into that student's own account.
- **Using it needs the device unlock.** `userVerification: 'required'`, so a face,
  a fingerprint or a passcode every time.

Those three are what make a passkey not a bearer token, and all three survive the
correction. What does not survive is "it physically cannot leave this handset".

### Where a passkey actually lives, and why that is two answers

"In the OS credential store" and "in your Google account" both get said, and they
sound contradictory. They answer different questions.

| | |
|---|---|
| **OS credential store** | *Who can reach it on this device.* A system store, read through the OS API — Android Credential Manager, iOS AutoFill — not browser storage. So clearing site data does nothing to it, Chrome and Samsung Internet and an in-app WebView all see the same passkey, and it is not tied to a browser profile. |
| **Your Google or Apple account** | *How it reaches your other devices.* The credential provider keeps an end-to-end encrypted copy synced through the account. The provider stores ciphertext; it cannot use the key. |

On Android the provider is Google Password Manager by default, but it is a
replaceable role — 1Password, Samsung Pass and others can hold it. On iOS it is
iCloud Keychain, similarly replaceable.

**The consequence for this app.** `excludeCredentials` is matched against what the
*provider* holds, and the provider spans every device signed into that account.
So the rule enforced by [One phone, many roll numbers](security.md#one-phone-many-roll-numbers)
is really **one passkey per keychain**, not one per handset — stronger than
claimed, because a student's second phone cannot enrol a classmate either. The
flip side is that a shared account is a shared keychain.

That last paragraph is reasoning from the specification, not something the suites
can prove: the virtual authenticators used in testing have no notion of an
account to sync through. It wants confirming on real hardware.

### What a student sees in their password manager

Not the credential id — that stays under the hood. What shows up is what
`register/options` sends:

| Field | Value | Where |
|---|---|---|
| Site | `Soft Skills Attendance` | `RP_NAME`, `passkey.ts` |
| Username | their roll number | `userName: student.roll_no` |
| Display name | their name | `userDisplayName: student.name` |

So the roll number is the human-visible label. Worth knowing before telling 47
students to look for something in their passwords list.

**The credential id is not a secret** and does not need to be one. It is an
identifier; without the private key it cannot produce a signature, and it is
per-relying-party, so it cannot correlate anybody across sites. This app now
publishes all of them to any caller holding a live QR token, which is what makes
one-passkey-per-keychain enforceable at all.

`register/options` used to leak one thing it should not have: a `needsApproval`
field saying whether the roll number just typed had already enrolled. Any caller
with a live QR token could ask about any roll number, and since a device with an
empty keychain can still claim an *unenrolled* one, the answer named the
claimable ones.

It was added so the screen could warn before the biometric prompt rather than
after. Nothing ever read it — no client, no test. So it cost a database round
trip and gave away enrolment state in exchange for a warning that was never
shown, and it is gone, along with the query and the cookie read that fed it.

The reply is now identical whichever roll number is asked about, and the edge
suite asserts that rather than trusting it: same field names, and the same
exclusion list, since that list is the whole class either way and so its length
cannot be read as "has this student enrolled".
