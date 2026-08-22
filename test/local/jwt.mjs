// Mints the service_role JWT PostgREST will accept, using the shared secret.
import { createHmac } from 'node:crypto'

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')

export function serviceRoleKey(secret) {
  const header = b64({ alg: 'HS256', typ: 'JWT' })
  const payload = b64({
    role: 'service_role',
    iss: 'local-test',
    iat: 1700000000,
    exp: 4000000000,
  })
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${sig}`
}

if (process.argv[1]?.endsWith('jwt.mjs')) {
  console.log(serviceRoleKey(process.argv[2] ?? process.env.PGRST_JWT_SECRET))
}
