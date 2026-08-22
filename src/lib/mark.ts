import { db } from '@/lib/supabase'

/**
 * Records a student present, idempotently.
 *
 * The primary key on (session_id, student_id) is what makes a second scan a
 * no-op rather than an error, so a student who touches the sensor twice sees the
 * same tick both times instead of a scary message.
 *
 * There is no device column any more. Under passkeys the identity is the
 * credential, and a credential id is not a device identifier — the same passkey
 * follows a student to a new phone through iCloud Keychain or Google Password
 * Manager. Recording something that looks like a device but is not one would be
 * worse than recording nothing, so the column was dropped rather than left to
 * be misread. See docs/superseded/.
 */
export async function markPresentForStudent(
  sessionId: string,
  studentId: string,
  source: 'scan' | 'manual'
): Promise<void> {
  const { error } = await db()
    .from('attendance')
    .upsert(
      { session_id: sessionId, student_id: studentId, source },
      { onConflict: 'session_id,student_id', ignoreDuplicates: true }
    )
  if (error) throw error
}
