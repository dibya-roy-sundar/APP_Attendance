import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types'
import { env } from './env'

/**
 * Service-role client. Server-only — it bypasses RLS, so it must never be
 * imported from a Client Component. Every table has RLS on with no policies,
 * so this is the only key that can read or write anything.
 */
let client: ReturnType<typeof createClient<Database>> | null = null

export function db() {
  if (!client) {
    client = createClient<Database>(env.supabaseUrl, env.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }
  return client
}
