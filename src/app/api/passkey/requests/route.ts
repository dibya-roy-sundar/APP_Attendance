import { ok, guardAdmin } from '@/lib/api'
import { recentRequests } from '@/lib/passkey'
import { sweepRequests } from '@/lib/sweep'

/**
 * The last week of phone-change claims, whatever became of them.
 *
 * Visible to a deputy as well as the instructor — somebody covering the class
 * needs to see that a student is stuck, even though only the instructor can
 * decide. Carries the question, never the credential: no public key, no
 * credential id, nothing that could be replayed.
 *
 * Filtering by status happens in the panel. A week of claims for one class is a
 * handful of rows, so there is nothing to gain from doing it here and a query
 * parameter to get wrong.
 *
 * Cleanup rides along behind the response — see sweepRequests().
 */
export async function GET() {
  const guard = await guardAdmin()
  if (!guard.ok) return guard.response

  const requests = await recentRequests()
  sweepRequests()
  return ok({ requests })
}

export const dynamic = 'force-dynamic'
