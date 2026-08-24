import { after } from 'next/server'
import { ok, guardAdmin } from '@/lib/api'
import { pruneRequests, recentRequests } from '@/lib/passkey'

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
 * Cleanup rides along behind the response. The seven-day window is enforced by
 * the query, so deleting older rows is housekeeping rather than correctness and
 * has no business adding a DELETE round trip to the admin's page load. `after`
 * rather than a bare un-awaited promise: on Vercel the container can be frozen
 * the moment the response is flushed, which would abandon the delete halfway.
 * Errors are dropped — a cleanup that did not run has no visible consequence,
 * and must not turn a working panel into a broken one.
 */
export async function GET() {
  const guard = await guardAdmin()
  if (!guard.ok) return guard.response

  const requests = await recentRequests()
  after(async () => {
    try {
      await pruneRequests()
    } catch {
      // Housekeeping only. Next read tries again.
    }
  })

  return ok({ requests })
}

export const dynamic = 'force-dynamic'
