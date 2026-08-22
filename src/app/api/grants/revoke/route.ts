import { actorOf } from '@/lib/admin'
import { fail, guardPrimary, isUuid, ok, readJson } from '@/lib/api'
import { audit } from '@/lib/data'
import { db } from '@/lib/supabase'

/**
 * Ends a deputy's access immediately. Their cookie is re-checked against this
 * row on every request, so there is no window where a revoked code still works.
 */
export async function POST(req: Request) {
  const guard = await guardPrimary()
  if (!guard.ok) return guard.response

  const { grantId } = await readJson(req)
  if (!isUuid(grantId)) return fail('BAD_REQUEST')

  const { data, error } = await db()
    .from('admin_grants')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', grantId)
    .is('revoked_at', null)
    .select('id, label')
    .maybeSingle()
  if (error) throw error
  if (!data) return fail('NOT_FOUND', 404)

  await audit({
    action: 'GRANT_REVOKED',
    actor: actorOf(guard.principal),
    reason: data.label,
  })
  return ok({ status: 'REVOKED', label: data.label })
}
