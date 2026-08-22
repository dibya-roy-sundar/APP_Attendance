import { fail, ok, readJson } from '@/lib/api'
import { isSecureRequest } from '@/lib/admin'
import { getSessionById, getStudentById } from '@/lib/data'
import {
  consumeChallenge,
  counterIsSane,
  credentialById,
  expectedOrigin,
  rpID,
  touchCredential,
} from '@/lib/passkey'
import { markPresentForStudent } from '@/lib/mark'
import { setStudentSession } from '@/lib/student-session'
import { verifyToken } from '@/lib/token'
import { verifyAuthenticationResponse } from '@simplewebauthn/server'

/**
 * Step two: verify the assertion and mark the signer present.
 *
 * Two independent things must both hold, and neither substitutes for the other:
 *
 *   who  — a signature over a server-issued challenge, by a key whose public
 *          half we already hold against a student.
 *   where — a live QR token, which only exists on the projector in the room.
 *
 * A stolen session cookie cannot mark anyone present, because it proves neither.
 */
export async function POST(req: Request) {
  const body = await readJson(req)
  const { s, t, response, challenge } = body as {
    s?: string
    t?: string
    response?: { id?: string }
    challenge?: string
  }
  if (typeof s !== 'string' || !s) return fail('MISSING_SESSION')
  if (!response?.id || typeof challenge !== 'string' || !challenge) return fail('BAD_REQUEST')

  const session = await getSessionById(s)
  if (!session) return fail('SESSION_CLOSED', 409)
  if (!session.is_open || new Date(session.expires_at).getTime() <= Date.now()) {
    return fail('SESSION_CLOSED', 409)
  }
  if (!verifyToken(session.secret, session.id, t as string, Date.now(), session.window_seconds)) {
    return fail('BAD_TOKEN', 409)
  }

  // Consumed before verification, so a challenge cannot be spent twice even if
  // verification is slow and two requests arrive together.
  const consumed = await consumeChallenge(challenge, 'authenticate')
  if (!consumed) return fail('CHALLENGE_EXPIRED', 409)

  const stored = await credentialById(response.id)
  if (!stored) return fail('UNKNOWN_PASSKEY', 404)

  let verification
  try {
    verification = await verifyAuthenticationResponse({
      response: response as never,
      expectedChallenge: challenge,
      expectedOrigin: expectedOrigin(req),
      expectedRPID: rpID(req),
      requireUserVerification: true,
      credential: {
        id: stored.credential_id,
        publicKey: new Uint8Array(Buffer.from(stored.public_key, 'base64url')),
        counter: Number(stored.counter),
        transports: (stored.transports ?? undefined) as never,
      },
    })
  } catch {
    return fail('BAD_ASSERTION', 400)
  }
  if (!verification.verified) return fail('BAD_ASSERTION', 400)

  // A counter that fails to advance means a replay or a cloned credential.
  // Platform authenticators that always report 0 are normal and allowed.
  const presented = verification.authenticationInfo.newCounter
  if (!counterIsSane(Number(stored.counter), presented)) return fail('BAD_ASSERTION', 400)

  const student = await getStudentById(stored.student_id)
  if (!student) return fail('UNKNOWN_PASSKEY', 404)

  await touchCredential(stored.credential_id, presented)
  await markPresentForStudent(session.id, student.id, 'scan')

  return setStudentSession(
    ok({
      status: 'MARKED',
      name: student.name,
      rollNo: student.roll_no,
      classDate: session.class_date,
    }),
    student.id,
    isSecureRequest(req)
  )
}

export const dynamic = 'force-dynamic'
