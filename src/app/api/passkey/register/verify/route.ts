import { fail, ok, readJson } from '@/lib/api'
import { isSecureRequest } from '@/lib/admin'
import { audit, getSessionById, getStudentById } from '@/lib/data'
import {
  consumeChallenge,
  deviceLabelFrom,
  expectedOrigin,
  rpID,
  saveCredential,
} from '@/lib/passkey'
import { markPresentForStudent } from '@/lib/mark'
import { setStudentSession } from '@/lib/student-session'
import { verifyToken } from '@/lib/token'
import { verifyRegistrationResponse } from '@simplewebauthn/server'

/**
 * Step two: verify the attestation, store the public key, mark them present.
 *
 * The challenge is consumed here, so a replayed registration finds nothing to
 * verify against. The expected origin and RP ID come from this server's own
 * configuration rather than from the request.
 */
export async function POST(req: Request) {
  const body = await readJson(req)
  const { s, t, response, challenge } = body as {
    s?: string
    t?: string
    response?: unknown
    challenge?: string
  }
  if (typeof s !== 'string' || !s) return fail('MISSING_SESSION')
  if (!response || typeof challenge !== 'string' || !challenge) return fail('BAD_REQUEST')

  const session = await getSessionById(s)
  if (!session) return fail('SESSION_CLOSED', 409)
  if (!session.is_open || new Date(session.expires_at).getTime() <= Date.now()) {
    return fail('SESSION_CLOSED', 409)
  }
  // Presence is checked again here, not just when options were issued: the
  // options step is cheap to call and the token could have lapsed since.
  if (!verifyToken(session.secret, session.id, t as string, Date.now(), session.window_seconds)) {
    return fail('BAD_TOKEN', 409)
  }

  const consumed = await consumeChallenge(challenge, 'register')
  if (!consumed || !consumed.studentId) return fail('CHALLENGE_EXPIRED', 409)

  let verification
  try {
    verification = await verifyRegistrationResponse({
      response: response as never,
      expectedChallenge: challenge,
      expectedOrigin: expectedOrigin(req),
      expectedRPID: rpID(req),
      requireUserVerification: true,
    })
  } catch {
    return fail('BAD_ATTESTATION', 400)
  }
  if (!verification.verified || !verification.registrationInfo) return fail('BAD_ATTESTATION', 400)

  const { credential } = verification.registrationInfo
  const saved = await saveCredential({
    studentId: consumed.studentId,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: (credential.transports as string[] | undefined) ?? null,
    deviceLabel: deviceLabelFrom(req.headers.get('user-agent')),
  })
  // The credential already belongs to somebody. Not necessarily an attack — a
  // double-submitted form does this — so it is reported plainly.
  if (saved.conflict) return fail('PASSKEY_ALREADY_REGISTERED', 409)

  const student = await getStudentById(consumed.studentId)
  if (!student) return fail('UNKNOWN_ROLL', 404)

  await markPresentForStudent(session.id, student.id, 'scan')
  await audit({
    action: 'PASSKEY_REGISTERED',
    studentId: student.id,
    sessionId: session.id,
    actor: 'student',
    reason: deviceLabelFrom(req.headers.get('user-agent')) ?? 'unknown device',
  })

  return setStudentSession(
    ok({
      status: 'REGISTERED',
      name: student.name,
      rollNo: student.roll_no,
      classDate: session.class_date,
    }),
    student.id,
    isSecureRequest(req)
  )
}

export const dynamic = 'force-dynamic'
