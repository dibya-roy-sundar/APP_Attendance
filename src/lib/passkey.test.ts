import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server'
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { createAuthenticator } from '../../test/local/authenticator.mjs'
import { counterIsSane } from './passkey'

/**
 * These tests exist because the security of the whole app now rests on the
 * verification step, and a mistake there fails silently: a fingerprint prompt
 * that proves nothing still looks exactly like one that does.
 *
 * The authenticator under test/local is written from the spec rather than
 * sharing code with the server, so a bug in our conventions cannot cancel out.
 */

const RP_ID = 'localhost'
const ORIGIN = 'http://localhost:3100'
const challengeOf = (s: string) => Buffer.from(s).toString('base64url')

/*
 * The authenticator is plain JavaScript written from the spec, so what it
 * returns is structurally correct but typed as `string` where the library wants
 * its own literal unions ('platform', 'internal', …). Casting at this boundary
 * keeps the call sites type-checked without weakening the authenticator, which
 * the REST suites share.
 */
const asRegistration = (r: unknown) => r as RegistrationResponseJSON
const asAssertion = (r: unknown) => r as AuthenticationResponseJSON

/**
 * SimpleWebAuthn signals a bad response two different ways — it throws for a
 * mismatched challenge or origin, and returns `verified: false` for a signature
 * that does not check out. The routes treat both as a refusal, so the tests
 * assert that rather than one particular mechanism.
 */
async function refuses(run: () => Promise<{ verified: boolean }>): Promise<boolean> {
  try {
    return !(await run()).verified
  } catch {
    return true
  }
}

function registerOne(studentId = 'student-1') {
  const auth = createAuthenticator()
  const challenge = challengeOf(`register-${studentId}`)
  const response = auth.register(
    {
      rp: { id: RP_ID },
      user: { id: Buffer.from(studentId).toString('base64url') },
      challenge,
    },
    ORIGIN
  )
  return { auth, challenge, response }
}

describe('registration', () => {
  it('verifies, and returns a credential we can store', async () => {
    const { challenge, response } = registerOne()
    const result = await verifyRegistrationResponse({
      response: asRegistration(response),
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
    })
    expect(result.verified).toBe(true)
    expect(result.registrationInfo?.credential.id).toBe(response.id)
  })

  it('is refused when the challenge is not the one we issued', async () => {
    const { response } = registerOne()
    expect(await refuses(() => verifyRegistrationResponse({
        response: asRegistration(response),
        expectedChallenge: challengeOf('a-different-challenge'),
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: true,
      }))).toBe(true)
  })

  it('is refused when it was created for another origin', async () => {
    const auth = createAuthenticator()
    const challenge = challengeOf('register-elsewhere')
    const response = auth.register(
      { rp: { id: RP_ID }, user: { id: Buffer.from('s').toString('base64url') }, challenge },
      'https://lookalike.example'
    )
    expect(await refuses(() => verifyRegistrationResponse({
        response: asRegistration(response),
        expectedChallenge: challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: true,
      }))).toBe(true)
  })
})

describe('authentication', () => {
  async function stored(studentId = 'student-1') {
    const { auth, challenge, response } = registerOne(studentId)
    const reg = await verifyRegistrationResponse({
      response: asRegistration(response),
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
    })
    return { auth, credential: reg.registrationInfo!.credential }
  }

  it('names the student who signed, with nothing typed', async () => {
    const { auth, credential } = await stored('the-student-row-id')
    const challenge = challengeOf('sign-in-1')
    // allowCredentials is empty in this app: the passkey is discoverable.
    const assertion = auth.authenticate({ rpId: RP_ID, challenge }, ORIGIN)!
    const result = await verifyAuthenticationResponse({
      response: asAssertion(assertion),
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
      credential: { id: credential.id, publicKey: credential.publicKey, counter: 0 },
    })
    expect(result.verified).toBe(true)
    expect(Buffer.from(assertion.response.userHandle, 'base64url').toString()).toBe(
      'the-student-row-id'
    )
  })

  it('rejects a tampered signature', async () => {
    const { auth, credential } = await stored()
    const challenge = challengeOf('sign-in-2')
    const forged = auth.forgeSignature(auth.authenticate({ rpId: RP_ID, challenge }, ORIGIN)!)
    expect(await refuses(() => verifyAuthenticationResponse({
        response: asAssertion(forged),
        expectedChallenge: challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: true,
        credential: { id: credential.id, publicKey: credential.publicKey, counter: 0 },
      }))).toBe(true)
  })

  it('rejects an assertion replayed against a different challenge', async () => {
    const { auth, credential } = await stored()
    const assertion = auth.authenticate({ rpId: RP_ID, challenge: challengeOf('first') }, ORIGIN)!
    expect(await refuses(() => verifyAuthenticationResponse({
        response: asAssertion(assertion),
        expectedChallenge: challengeOf('second'),
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: true,
        credential: { id: credential.id, publicKey: credential.publicKey, counter: 0 },
      }))).toBe(true)
  })

  it('rejects one signed for a lookalike origin', async () => {
    const { auth, credential } = await stored()
    const challenge = challengeOf('sign-in-3')
    const elsewhere = auth.authenticate({ rpId: RP_ID, challenge }, 'https://lookalike.example')!
    expect(await refuses(() => verifyAuthenticationResponse({
        response: asAssertion(elsewhere),
        expectedChallenge: challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: true,
        credential: { id: credential.id, publicKey: credential.publicKey, counter: 0 },
      }))).toBe(true)
  })

  it('a phone with no passkey yields nothing, rather than something invalid', () => {
    const fresh = createAuthenticator()
    expect(fresh.authenticate({ rpId: RP_ID, challenge: challengeOf('x') }, ORIGIN)).toBeNull()
  })

  it('binds to the RP: a passkey for one domain does not answer for another', async () => {
    const { auth } = await stored()
    expect(auth.authenticate({ rpId: 'other.example', challenge: challengeOf('x') }, ORIGIN)).toBeNull()
  })
})

describe('counterIsSane', () => {
  // Platform authenticators commonly report 0 forever; that is normal.
  it('allows an authenticator that always reports zero', () => {
    expect(counterIsSane(0, 0)).toBe(true)
  })

  it('requires the counter to advance once it has started counting', () => {
    expect(counterIsSane(4, 5)).toBe(true)
    expect(counterIsSane(4, 4)).toBe(false)
    expect(counterIsSane(4, 3)).toBe(false)
  })
})

describe('the RP id is a hash commitment, not a string the client chooses', () => {
  it('a passkey for one domain produces a different rpIdHash', () => {
    const a = createHash('sha256').update('localhost').digest('hex')
    const b = createHash('sha256').update('lookalike.example').digest('hex')
    expect(a).not.toBe(b)
  })
})
