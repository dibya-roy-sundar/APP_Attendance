/**
 * A student's phone, for the REST harnesses.
 *
 * Wraps the two passkey exchanges so a suite can say "this phone registers as
 * MT2026002" or "this phone marks present" without restating four requests each
 * time. Each `phone()` owns its own authenticator, which is what makes two
 * phones genuinely distinct: separate keys, separate keychains.
 */
import { createAuthenticator } from './authenticator.mjs'

/** A fresh phone with an empty keychain. */
export function phone(base) {
  const authenticator = createAuthenticator()
  let sessionCookie = null

  async function post(path, body, extra = {}) {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(sessionCookie ? { cookie: sessionCookie } : {}),
        ...(extra.headers ?? {}),
      },
      body: JSON.stringify(body),
    })
    const setCookie = res.headers.getSetCookie?.() ?? []
    const student = setCookie.find((c) => c.startsWith('att_student='))
    if (student) sessionCookie = student.split(';')[0]
    const type = res.headers.get('content-type') ?? ''
    return { status: res.status, data: type.includes('json') ? await res.json().catch(() => ({})) : null, res }
  }

  return {
    authenticator,
    /** The passkey session cookie, once one has been issued. */
    get cookie() {
      return sessionCookie
    },
    /** Throw away the session, as clearing site data would. The passkey stays. */
    forgetSession() {
      sessionCookie = null
    },
    /** Throw away the passkey too, as a genuinely lost phone would. */
    wipe() {
      authenticator.wipe()
      sessionCookie = null
    },

    /** First time on this phone: claim a roll number and create a passkey. */
    async register(sessionId, token, rollNo) {
      const options = await post('/api/passkey/register/options', {
        s: sessionId,
        t: token,
        rollNo,
      })
      if (options.status !== 200) return { stage: 'options', ...options }
      let attestation
      try {
        attestation = authenticator.register(options.data.options, options.data.origin)
      } catch (err) {
        // A real authenticator refuses a second credential for a user it
        // already holds one for; the suites assert that rather than a 4xx.
        return { stage: 'authenticator', status: 0, data: { error: err.name } }
      }
      const verified = await post('/api/passkey/register/verify', {
        s: sessionId,
        t: token,
        challenge: options.data.options.challenge,
        response: attestation,
      })
      return { stage: 'verify', ...verified }
    },

    /**
     * Every later class. `tamper` lets a suite prove the server checks rather
     * than assuming it: 'signature' forges one, 'challenge' substitutes another.
     */
    async markPresent(sessionId, token, { tamper } = {}) {
      const options = await post('/api/passkey/auth/options', { s: sessionId, t: token })
      if (options.status !== 200) return { stage: 'options', ...options }

      let assertion = authenticator.authenticate(options.data.options, options.data.origin)
      if (!assertion) return { stage: 'no-passkey', status: 0, data: {} }
      if (tamper === 'signature') assertion = authenticator.forgeSignature(assertion)

      const verified = await post('/api/passkey/auth/verify', {
        s: sessionId,
        t: token,
        challenge:
          tamper === 'challenge'
            ? Buffer.from('a-challenge-we-never-issued').toString('base64url')
            : options.data.options.challenge,
        response: assertion,
      })
      return { stage: 'verify', ...verified }
    },

    /** The student's own record, which the passkey session is enough to read. */
    async record() {
      return post('/api/me', {})
    },
  }
}
