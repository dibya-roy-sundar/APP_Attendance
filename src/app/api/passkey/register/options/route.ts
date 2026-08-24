import { fail, ok, readJson } from '@/lib/api'
import { MAX_ROLL_LENGTH, getSessionById, getStudentByRollNo } from '@/lib/data'
import { RP_NAME, credentialsForStudent, expectedOrigin, rpID, storeChallenge } from '@/lib/passkey'
import { sweepChallenges } from '@/lib/sweep'
import { verifyToken } from '@/lib/token'
import { readStudentSession } from '@/lib/student-session'
import { generateRegistrationOptions } from '@simplewebauthn/server'

/**
 * Step one of registering a passkey.
 *
 * Gated on a live QR token, which is the only proof of presence the app has:
 * being in the room looking at the projector is the authorisation to register.
 * That is what replaced the old admin-controlled registration window, and it is
 * also why no admin has to be involved when a student changes phone.
 */
export async function POST(req: Request) {
  const body = await readJson(req)
  const { s, t } = body as { s?: string; t?: string }
  const rollNo = typeof body.rollNo === 'string' ? body.rollNo.trim() : ''

  if (typeof s !== 'string' || !s) return fail('MISSING_SESSION')
  if (!rollNo || rollNo.length > MAX_ROLL_LENGTH) return fail('UNKNOWN_ROLL')

  const session = await getSessionById(s)
  if (!session) return fail('SESSION_CLOSED', 409)
  if (!session.is_open || new Date(session.expires_at).getTime() <= Date.now()) {
    return fail('SESSION_CLOSED', 409)
  }
  if (!verifyToken(session.secret, session.id, t as string, Date.now(), session.window_seconds)) {
    return fail('BAD_TOKEN', 409)
  }

  const student = await getStudentByRollNo(rollNo)
  if (!student) return fail('UNKNOWN_ROLL', 404)

  const existing = await credentialsForStudent(student.id)

  /*
   * A roll number that already has a passkey cannot be claimed again by a
   * stranger.
   *
   * Being in the room with a live token is enough to claim an *unclaimed* roll
   * number — that case is self-correcting, because the real student is told it
   * is taken and the admin clears it. It is nowhere near enough to add a second
   * passkey to a student who already has one: that would let anybody in the
   * room mark an absent classmate present, that class and silently every class
   * afterwards. The device-binding scheme refused this through a unique column;
   * making credentials one-to-many removed the protection, and this puts it
   * back.
   *
   * The exception is proving you are already that student, by holding a session
   * this server issued for them — which only a verified passkey assertion can
   * produce. That covers moving to a new phone while you still have the old one.
   *
   * A genuinely lost phone cannot do that, and the server has no way to tell it
   * apart from a stranger's phone: both are an unknown device asking for a roll
   * number that is taken. So it does not try. The claim becomes a row in
   * passkey_requests and the instructor decides, which is also what turns every
   * refused claim into evidence. Rare either way — within one ecosystem a
   * passkey follows you to a new phone by itself.
   */
  // Options are issued either way. A roll number that already has a passkey
  // still gets a challenge, because the claim has to be *verified* before it can
  // be judged — an unverified request would be worthless as evidence, and would
  // let anyone queue a claim for anyone without holding a phone at all. Whether
  // it becomes a credential or a request is decided in register/verify.
  const replacing = existing.length > 0 && readStudentSession(req) !== student.id

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpID(req),
    // The student's row id travels inside the passkey and comes back as
    // userHandle on every later sign-in. That is what lets authentication be
    // discoverable: nothing needs typing, ever again.
    userID: new TextEncoder().encode(student.id),
    userName: student.roll_no,
    userDisplayName: student.name,
    attestationType: 'none',
    // Stops the same device silently registering twice for one student, while
    // still allowing a *different* device to be added.
    excludeCredentials: existing.map((c) => ({
      id: c.credential_id,
      transports: (c.transports ?? undefined) as never,
    })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
      authenticatorAttachment: 'platform',
    },
  })

  sweepChallenges()
  await storeChallenge(options.challenge, 'register', student.id)
  return ok({
    options,
    origin: expectedOrigin(req),
    name: student.name,
    rollNo: student.roll_no,
    // Lets the screen warn before the biometric prompt, rather than after.
    needsApproval: replacing,
  })
}

export const dynamic = 'force-dynamic'
