/** Reads a required env var, failing loudly at first use rather than silently at runtime. */
function required(name: string): string {
  const v = process.env[name]
  if (!v) {
    throw new Error(
      `Missing environment variable ${name}. Copy .env.example to .env.local and fill it in.`
    )
  }
  return v
}

export const env = {
  get supabaseUrl() {
    return required('NEXT_PUBLIC_SUPABASE_URL')
  },
  get supabaseServiceKey() {
    return required('SUPABASE_SERVICE_ROLE_KEY')
  },
  get adminPassword() {
    return required('ADMIN_PASSWORD')
  },
  /**
   * The timezone the class actually happens in. `class_date` must be the day the
   * instructor sees on the wall clock, not the server's UTC day — otherwise an
   * evening class in IST lands on the wrong date.
   */
  get classTimezone() {
    return process.env.CLASS_TIMEZONE || 'Asia/Kolkata'
  },
  /**
   * The instructor is one of the 47 students, not a 48th person. Naming their
   * roll number lets the grid point at their own row so they can mark
   * themselves without hunting for it. Optional — unset simply means no row is
   * singled out.
   */
  get adminRollNo() {
    return process.env.ADMIN_ROLL_NO?.trim() || null
  },
}
