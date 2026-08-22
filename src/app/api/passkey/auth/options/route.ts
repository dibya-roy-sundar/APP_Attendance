import { fail, ok, readJson } from '@/lib/api'
import { getSessionById } from '@/lib/data'
import { expectedOrigin, pruneChallenges, rpID, storeChallenge } from '@/lib/passkey'
import { verifyToken } from '@/lib/token'
import { generateAuthenticationOptions } from '@simplewebauthn/server'

/**
 * Step one of marking present: a fresh challenge.
 *
 * `allowCredentials` is deliberately empty. The passkey is discoverable, so the
 * platform offers the right one and its userHandle tells us who signed — which
 * is why a student never types a roll number after the first time, and why this
 * endpoint leaks nothing about who is enrolled.
 */
export async function POST(req: Request) {
  const body = await readJson(req)
  const { s, t } = body as { s?: string; t?: string }
  if (typeof s !== 'string' || !s) return fail('MISSING_SESSION')

  const session = await getSessionById(s)
  if (!session) return fail('SESSION_CLOSED', 409)
  if (!session.is_open || new Date(session.expires_at).getTime() <= Date.now()) {
    return fail('SESSION_CLOSED', 409)
  }
  if (!verifyToken(session.secret, session.id, t as string, Date.now(), session.window_seconds)) {
    return fail('BAD_TOKEN', 409)
  }

  await pruneChallenges()

  const options = await generateAuthenticationOptions({
    rpID: rpID(req),
    allowCredentials: [],
    userVerification: 'required',
  })
  await storeChallenge(options.challenge, 'authenticate', null)
  return ok({ options, origin: expectedOrigin(req) })
}

export const dynamic = 'force-dynamic'
