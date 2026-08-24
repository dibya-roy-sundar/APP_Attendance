import { actorOf } from '@/lib/admin'
import { fail, guardPrimary, isUuid, ok, readJson } from '@/lib/api'
import { audit, getStudentById } from '@/lib/data'
import { decideRequest, replaceCredential, requestById } from '@/lib/passkey'

/**
 * Approve or reject a claim on a roll number that already has a passkey.
 *
 * Instructor only. A deputy can see the queue but not decide it: approving is
 * the one action that hands control of a student's attendance to a new device,
 * and it should belong to the person who owns the register.
 *
 * Approving replaces the existing passkey rather than adding to it, because one
 * per student is the invariant that stops a stranger quietly holding a second
 * key to somebody else's attendance.
 *
 * Rejecting keeps the row. A rejected claim is the record of an attempted
 * proxy — who, when, from what device — and that is worth more than a tidy
 * table. Cleanup only removes rows after a fortnight.
 */
export async function POST(req: Request) {
  const guard = await guardPrimary()
  if (!guard.ok) return guard.response

  const body = await readJson(req)
  const { requestId, approve } = body as { requestId?: string; approve?: boolean }
  const note = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : ''
  if (!isUuid(requestId) || typeof approve !== 'boolean') return fail('BAD_REQUEST')

  const request = await requestById(requestId)
  if (!request) return fail('NO_REQUEST', 404)
  if (new Date(request.expires_at).getTime() <= Date.now()) return fail('REQUEST_EXPIRED', 409)

  // Guarded so two admins tapping at once cannot both decide.
  const decided = await decideRequest(requestId, approve ? 'approved' : 'rejected')
  if (!decided) return fail('ALREADY_DECIDED', 409)

  const student = await getStudentById(request.student_id)
  const where = request.device_label ?? 'unknown device'

  if (approve) {
    await replaceCredential(request.student_id, {
      credentialId: request.credential_id,
      publicKey: request.public_key,
      counter: Number(request.counter),
      transports: request.transports,
      deviceLabel: request.device_label,
    })
  }

  await audit({
    action: approve ? 'PASSKEY_APPROVED' : 'PASSKEY_REJECTED',
    studentId: request.student_id,
    sessionId: request.session_id,
    actor: actorOf(guard.principal),
    reason: note ? `${note} — ${where}` : where,
  })

  return ok({
    status: approve ? 'APPROVED' : 'REJECTED',
    name: student?.name ?? null,
  })
}

export const dynamic = 'force-dynamic'
