/**
 * A software WebAuthn authenticator, so the REST harnesses can register and
 * sign in exactly as a phone does.
 *
 * The browser suites use Playwright's virtual authenticator over CDP, which is
 * closer to the real thing but only available in a browser. These suites talk
 * to the API directly, so they need to produce the bytes themselves: an
 * attestation object for registration and a signed assertion for each sign-in.
 *
 * Deliberately built from the spec rather than a library. A helper that shared
 * code with the server would verify its own conventions and prove nothing —
 * these tests should fail if the server starts accepting the wrong bytes.
 */
import { createHash, createSign, generateKeyPairSync } from 'node:crypto'

const b64u = (buf) => Buffer.from(buf).toString('base64url')
const fromB64u = (s) => Buffer.from(s, 'base64url')

/* ── the sliver of CBOR that WebAuthn needs ─────────────────────────────── */

function cborHead(major, value) {
  if (value < 24) return Buffer.from([(major << 5) | value])
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value])
  if (value < 0x10000) {
    const b = Buffer.alloc(3)
    b[0] = (major << 5) | 25
    b.writeUInt16BE(value, 1)
    return b
  }
  const b = Buffer.alloc(5)
  b[0] = (major << 5) | 26
  b.writeUInt32BE(value, 1)
  return b
}

function cbor(value) {
  if (typeof value === 'number') {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -value - 1)
  }
  if (typeof value === 'string') {
    const b = Buffer.from(value, 'utf8')
    return Buffer.concat([cborHead(3, b.length), b])
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([cborHead(2, value.length), value])
  if (value instanceof Map) {
    const parts = [cborHead(5, value.size)]
    for (const [k, v] of value) parts.push(cbor(k), cbor(v))
    return Buffer.concat(parts)
  }
  throw new Error(`cbor: unsupported ${typeof value}`)
}

/* ── the authenticator ──────────────────────────────────────────────────── */

const AAGUID = Buffer.alloc(16) // all zeroes, as platform authenticators report

/**
 * One authenticator holds one credential per (rpId, user) it is asked to
 * create, keyed by credential id — the same shape as a phone's keychain.
 */
export function createAuthenticator() {
  const credentials = new Map()

  /** Raw P-256 x and y, which is what a COSE ES256 key carries. */
  function coseKey(publicKey) {
    const der = publicKey.export({ type: 'spki', format: 'der' })
    // An uncompressed P-256 point is the last 65 bytes: 0x04 || x(32) || y(32).
    const point = der.subarray(der.length - 65)
    if (point[0] !== 0x04) throw new Error('expected an uncompressed EC point')
    return cbor(
      new Map([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, point.subarray(1, 33)], // x
        [-3, point.subarray(33, 65)], // y
      ])
    )
  }

  function authData(rpId, flags, signCount, attested) {
    const parts = [
      createHash('sha256').update(rpId).digest(),
      Buffer.from([flags]),
      (() => {
        const b = Buffer.alloc(4)
        b.writeUInt32BE(signCount, 0)
        return b
      })(),
    ]
    if (attested) parts.push(attested)
    return Buffer.concat(parts)
  }

  function clientData(type, challenge, origin) {
    return Buffer.from(
      JSON.stringify({ type, challenge, origin, crossOrigin: false }),
      'utf8'
    )
  }

  return {
    /** How many credentials this authenticator holds — a phone's keychain. */
    get size() {
      return credentials.size
    },

    /** Forget everything, as clearing a keychain would. */
    wipe() {
      credentials.clear()
    },

    /** navigator.credentials.create(), as a phone would answer it. */
    register(options, origin) {
      const rpId = options.rp.id
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      const credentialId = Buffer.from(
        createHash('sha256').update(`${rpId}:${options.user.id}:${credentials.size}:${Date.now()}`).digest()
      ).subarray(0, 32)

      const cose = coseKey(publicKey)
      const attested = Buffer.concat([
        AAGUID,
        (() => {
          const b = Buffer.alloc(2)
          b.writeUInt16BE(credentialId.length, 0)
          return b
        })(),
        credentialId,
        cose,
      ])
      // UP | UV | AT
      const data = authData(rpId, 0x01 | 0x04 | 0x40, 0, attested)
      const attestationObject = cbor(
        new Map([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', data],
        ])
      )
      const cd = clientData('webauthn.create', options.challenge, origin)

      credentials.set(b64u(credentialId), {
        privateKey,
        rpId,
        userHandle: fromB64u(options.user.id),
        signCount: 0,
      })

      return {
        id: b64u(credentialId),
        rawId: b64u(credentialId),
        type: 'public-key',
        authenticatorAttachment: 'platform',
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64u(cd),
          attestationObject: b64u(attestationObject),
          transports: ['internal'],
        },
      }
    },

    /**
     * navigator.credentials.get(). `allowCredentials` is empty in this app, so
     * the authenticator picks a resident credential for the RP itself — which is
     * exactly the discoverable behaviour the app depends on.
     */
    authenticate(options, origin, { credentialId } = {}) {
      const rpId = options.rpId
      const chosen = credentialId
        ? [credentialId, credentials.get(credentialId)]
        : [...credentials.entries()].reverse().find(([, c]) => c.rpId === rpId)
      if (!chosen || !chosen[1]) return null // no passkey here, as a fresh phone

      const [id, cred] = chosen
      cred.signCount += 1
      const data = authData(rpId, 0x01 | 0x04, cred.signCount, null) // UP | UV
      const cd = clientData('webauthn.get', options.challenge, origin)
      const signature = createSign('SHA256')
        .update(Buffer.concat([data, createHash('sha256').update(cd).digest()]))
        .sign(cred.privateKey)

      return {
        id,
        rawId: id,
        type: 'public-key',
        authenticatorAttachment: 'platform',
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64u(cd),
          authenticatorData: b64u(data),
          signature: b64u(signature),
          userHandle: b64u(cred.userHandle),
        },
      }
    },

    /** Tamper hooks, so the suites can prove the server actually checks. */
    forgeSignature(assertion) {
      const bad = Buffer.from(fromB64u(assertion.response.signature))
      bad[bad.length - 1] ^= 0xff
      return { ...assertion, response: { ...assertion.response, signature: b64u(bad) } }
    },

    /** Replays the previous counter, which a cloned credential would do. */
    rewindCounter(id) {
      const cred = credentials.get(id)
      if (cred) cred.signCount = Math.max(0, cred.signCount - 2)
    },
  }
}
