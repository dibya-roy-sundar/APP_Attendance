// supabase-js talks to <url>/rest/v1/*; PostgREST serves /*. Bridge the two.
import { createServer } from 'node:http'

const UPSTREAM = process.env.UPSTREAM ?? 'http://127.0.0.1:54323'
const PORT = Number(process.env.PORT ?? 54321)

createServer(async (req, res) => {
  const path = req.url.replace(/^\/rest\/v1/, '')
  const chunks = []
  for await (const c of req) chunks.push(c)

  const headers = { ...req.headers }
  delete headers.host
  delete headers['content-length']

  try {
    const upstream = await fetch(UPSTREAM + path, {
      method: req.method,
      headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    })
    res.writeHead(upstream.status, Object.fromEntries(upstream.headers))
    res.end(Buffer.from(await upstream.arrayBuffer()))
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: String(e) }))
  }
}).listen(PORT, () => console.log(`proxy :${PORT} -> ${UPSTREAM}`))
