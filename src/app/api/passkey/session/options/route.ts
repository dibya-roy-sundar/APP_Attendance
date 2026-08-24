import { ok } from '@/lib/api'
import { expectedOrigin, rpID, storeChallenge } from '@/lib/passkey'
import { sweepChallenges } from '@/lib/sweep'
import { generateAuthenticationOptions } from '@simplewebauthn/server'

/**
 * A challenge for reading your own record, with no class in session.
 *
 * Everything else in this app requires a live QR token, because everything else
 * either records attendance or authorises registering for it, and the token is
 * the only proof of being in the room. Reading your own percentage is neither.
 *
 * Without this a student who cleared their cookies between classes could not
 * see their own attendance until the next lesson started — the only path to a
 * session ran through /api/passkey/auth/options, which needs a live token.
 *
 * The challenge is stored with purpose 'authenticate', the same as the marking
 * flow. That is deliberate and safe: the purpose is not what gates marking, the
 * *token* is. A challenge minted here carries no token, so presenting it to
 * /api/passkey/auth/verify still fails without one — and a student in class
 * could have obtained a challenge there anyway. Keeping one purpose avoids a
 * schema change whose only benefit would be tidiness.
 */
export async function POST(req: Request) {
  const options = await generateAuthenticationOptions({
    rpID: rpID(req),
    // Discoverable: the passkey says who it belongs to, so this endpoint being
    // open reveals nothing about who is enrolled.
    allowCredentials: [],
    userVerification: 'required',
  })
  sweepChallenges()
  await storeChallenge(options.challenge, 'authenticate', null)
  return ok({ options, origin: expectedOrigin(req) })
}

export const dynamic = 'force-dynamic'
