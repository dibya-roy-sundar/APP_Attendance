import { ok, guardAdmin } from '@/lib/api'
import { classDate } from '@/lib/dates'
import { pendingRequests } from '@/lib/passkey'

/**
 * Claims waiting for a decision.
 *
 * Visible to a deputy as well as the instructor — somebody covering the class
 * needs to see that a student is stuck, even though only the instructor can
 * decide. Nothing here reveals a public key or a credential id; it is the
 * question, not the credential.
 */
export async function GET() {
  const guard = await guardAdmin()
  if (!guard.ok) return guard.response
  return ok({ requests: await pendingRequests(classDate()) })
}

export const dynamic = 'force-dynamic'
