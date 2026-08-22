import { fail, ok, readJson } from '@/lib/api'
import { MAX_ROLL_LENGTH, getSessionById, getStudentByRollNo } from '@/lib/data'
import { RP_NAME, credentialsForStudent, expectedOrigin, pruneChallenges, rpID, storeChallenge } from '@/lib/passkey'
import { verifyToken } from '@/lib/token'
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

  await pruneChallenges()

  const existing = await credentialsForStudent(student.id)
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

  await storeChallenge(options.challenge, 'register', student.id)
  return ok({ options, origin: expectedOrigin(req), name: student.name, rollNo: student.roll_no })
}

export const dynamic = 'force-dynamic'
