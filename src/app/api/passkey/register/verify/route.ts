import { fail, ok, readJson } from '@/lib/api'
import { isSecureRequest } from '@/lib/admin'
import { audit, getSessionById, getStudentById } from '@/lib/data'
import {
  consumeChallenge,
  credentialsForStudent,
  recordRequest,
  deviceLabelFrom,
  expectedOrigin,
  rpID,
  saveCredential,
} from '@/lib/passkey'
import { markPresentForStudent } from '@/lib/mark'
import { readStudentSession, setStudentSession } from '@/lib/student-session'
import { callerKey } from '@/lib/throttle'
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

  const heldSession = readStudentSession(req)
  const ownSession = heldSession === consumed.studentId
  /*
   * This browser already holds a session this server issued for a *different*
   * student. Enrolling a second roll number from here is therefore never the
   * innocent first-time case, whatever else it might be, so it is queued for
   * the admin rather than written.
   *
   * The cookie is clearable, so this is a cost, not a wall — and deliberately
   * so: the check that actually enforces one passkey per phone is
   * excludeCredentials, which the authenticator applies before any of this runs.
   * This catches the same attempt one layer further in, for the case where the
   * caller controls the WebAuthn call and simply dropped the exclusion list.
   */
  const differentStudent = heldSession !== null && heldSession !== consumed.studentId

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

  const student = await getStudentById(consumed.studentId)
  if (!student) return fail('UNKNOWN_ROLL', 404)

  const { credential } = verification.registrationInfo
  const shape = {
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: (credential.transports as string[] | undefined) ?? null,
    deviceLabel: deviceLabelFrom(req.headers.get('user-agent')),
  }

  /*
   * The student already holds a passkey, and this request cannot prove it is
   * them. Not necessarily an attack — a lost phone looks identical from here —
   * so the claim is queued for the admin rather than thrown away. Queuing it
   * is also what makes an attempted proxy visible: a request for a student who
   * never changed phone is exactly that, stamped with a time and a device.
   *
   * Nothing is marked present. That is the point.
   */
  if (!ownSession) {
    const held = await credentialsForStudent(consumed.studentId)
    if (held.length > 0 || differentStudent) {
      await recordRequest({
        studentId: consumed.studentId,
        ...shape,
        sessionId: session.id,
        caller: callerKey(req),
      })
      await audit({
        action: 'PASSKEY_REQUESTED',
        studentId: consumed.studentId,
        sessionId: session.id,
        actor: 'student',
        reason: differentStudent
          ? `claim from ${shape.deviceLabel ?? 'unknown device'} already signed in as another student`
          : `claim from ${shape.deviceLabel ?? 'unknown device'}, awaiting approval`,
      })
      return fail('NEEDS_APPROVAL', 409, { name: student.name })
    }
  }

  /*
   * Otherwise this is a first claim, and the unique index on
   * student_credentials(student_id) is what settles a race: check-then-insert
   * has a window in which three simultaneous claims all pass, a unique
   * constraint has none. A violation here means somebody else won by
   * microseconds, so their claim becomes a request too.
   */
  const saved = await saveCredential({ studentId: consumed.studentId, ...shape })
  if (saved.conflict) {
    await recordRequest({
      studentId: consumed.studentId,
      ...shape,
      sessionId: session.id,
      caller: callerKey(req),
    })
    return fail('NEEDS_APPROVAL', 409, { name: student.name })
  }

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
