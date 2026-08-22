import { fail, ok, readJson } from '@/lib/api'
import { isSecureRequest } from '@/lib/admin'
import { getStudentById } from '@/lib/data'
import {
  consumeChallenge,
  counterIsSane,
  credentialById,
  expectedOrigin,
  rpID,
  touchCredential,
} from '@/lib/passkey'
import { setStudentSession } from '@/lib/student-session'
import { verifyAuthenticationResponse } from '@simplewebauthn/server'

/**
 * Signs a student in to read their own record. Records nothing.
 *
 * Identical verification to /api/passkey/auth/verify — same single-use
 * challenge, same origin and RP ID from server config, same signature and
 * counter checks — and deliberately missing the two things that make that
 * route able to change the register: it takes no session id and no token, and
 * it never writes to `attendance`.
 */
export async function POST(req: Request) {
  const body = await readJson(req)
  const { response, challenge } = body as { response?: { id?: string }; challenge?: string }
  if (!response?.id || typeof challenge !== 'string' || !challenge) return fail('BAD_REQUEST')

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

  const presented = verification.authenticationInfo.newCounter
  if (!counterIsSane(Number(stored.counter), presented)) return fail('BAD_ASSERTION', 400)

  const student = await getStudentById(stored.student_id)
  if (!student) return fail('UNKNOWN_PASSKEY', 404)

  await touchCredential(stored.credential_id, presented)
  return setStudentSession(
    ok({ status: 'SIGNED_IN', name: student.name, rollNo: student.roll_no }),
    student.id,
    isSecureRequest(req)
  )
}

export const dynamic = 'force-dynamic'
