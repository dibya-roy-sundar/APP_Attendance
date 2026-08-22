import { actorOf } from '@/lib/admin'
import { fail, guardAdmin, isUuid, ok, readJson } from '@/lib/api'
import { getSessionById, listStudents } from '@/lib/data'
import { db } from '@/lib/supabase'

const MAX_REASON = 200
/** Comfortably above one class; a bigger list is a bug, not a roll call. */
const MAX_BATCH = 200

/**
 * Marks a batch of students present by hand, in one request.
 *
 * Insert-only and therefore idempotent, which is the point. The old toggle
 * endpoint read the current state and then flipped it, so two taps landing
 * together both saw "absent", both inserted, and the student ended up marked
 * when two taps should have cancelled out. Nothing here depends on prior state.
 *
 * An existing row is never overwritten, so a student who scanned keeps
 * `source = 'scan'` even if they were also staged by hand — scanning is the
 * better evidence, and the response says who was already there.
 */
export async function POST(req: Request) {
  const guard = await guardAdmin()
  if (!guard.ok) return guard.response

  const body = await readJson(req)
  const { sessionId } = body as { sessionId?: string }
  const reason =
    typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim().slice(0, MAX_REASON)
      : null

  if (!isUuid(sessionId)) return fail('BAD_REQUEST')
  if (!Array.isArray(body.studentIds)) return fail('BAD_REQUEST')
  if (body.studentIds.length === 0) return fail('EMPTY_BATCH')
  if (body.studentIds.length > MAX_BATCH) return fail('BATCH_TOO_LARGE')
  if (!body.studentIds.every(isUuid)) return fail('BAD_REQUEST')

  const session = await getSessionById(sessionId)
  if (!session) return fail('NO_SESSION', 404)

  // Only ids that are actually on the roster, de-duplicated.
  const roster = new Set((await listStudents()).map((s) => s.id))
  const ids = [...new Set(body.studentIds as string[])].filter((id) => roster.has(id))
  if (ids.length === 0) return fail('NO_STUDENT', 404)

  const { data: existing, error: readError } = await db()
    .from('attendance')
    .select('student_id')
    .eq('session_id', sessionId)
    .in('student_id', ids)
  if (readError) throw readError
  const already = new Set((existing ?? []).map((r) => r.student_id))
  const fresh = ids.filter((id) => !already.has(id))

  const markedAt = new Date().toISOString()
  if (fresh.length > 0) {
    const { error } = await db()
      .from('attendance')
      .upsert(
        fresh.map((id) => ({
          session_id: sessionId,
          student_id: id,
          marked_at: markedAt,
          source: 'manual' as const,
          device_id: null,
        })),
        { onConflict: 'session_id,student_id', ignoreDuplicates: true }
      )
    if (error) throw error

    // One audit row per student, so the log still answers "when was X marked".
    const actor = actorOf(guard.principal)
    const { error: auditError } = await db().from('audit_log').insert(
      fresh.map((id) => ({
        action: 'OVERRIDE_MARK' as const,
        student_id: id,
        session_id: sessionId,
        reason,
        actor,
      }))
    )
    if (auditError) console.error('audit_log batch write failed', auditError)
  }

  return ok({
    status: 'SAVED',
    saved: fresh.length,
    alreadyMarked: already.size,
    markedAt,
  })
}
