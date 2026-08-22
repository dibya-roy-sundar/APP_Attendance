import { fail, ok, guardAdmin } from '@/lib/api'
import { getSessionById } from '@/lib/data'
import { currentToken, msUntilNextWindow } from '@/lib/token'
import { scanUrl } from '@/lib/origin'
import type { NextRequest } from 'next/server'

/**
 * Lightweight poll for the admin's QR display. Returns only the token, never the
 * secret.
 *
 * Admin-gated on purpose. The session id travels in the QR URL, so leaving this
 * open would let any student who scanned once poll for a fresh token forever and
 * relay it to someone who never turned up — which is exactly what the 15-second
 * rotation exists to prevent. Only the projecting page needs this.
 */
export async function GET(req: NextRequest) {
  const guard = await guardAdmin()
  if (!guard.ok) return guard.response

  const sessionId = req.nextUrl.searchParams.get('s')
  if (!sessionId) return fail('MISSING_SESSION')

  const session = await getSessionById(sessionId)
  if (!session) return fail('NO_SESSION', 404)
  if (!session.is_open || new Date(session.expires_at).getTime() <= Date.now()) {
    return fail('SESSION_CLOSED', 409)
  }

  const now = Date.now()
  const token = currentToken(session.secret, session.id, now, session.window_seconds)
  return ok(
    {
      token,
      // Built here, not in the browser: the admin may be on a deployment URL
      // while the class must always land on the canonical origin.
      scanUrl: scanUrl(req, session.id, token),
      windowSeconds: session.window_seconds,
      refreshInMs: msUntilNextWindow(now, session.window_seconds),
      expiresAt: session.expires_at,
    },
    200
  )
}

export const dynamic = 'force-dynamic'
