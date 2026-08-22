/**
 * Hand-written mirror of supabase/schema.sql. Keeping it in the repo (rather
 * than generating it) means the compiler catches a column rename the moment the
 * schema and the code disagree.
 */
export type StudentRow = {
  id: string
  s_no: number
  roll_no: string
  name: string
  email: string | null
  device_id: string | null
  enrolled_at: string | null
}

export type SessionRow = {
  id: string
  class_date: string
  secret: string
  is_open: boolean
  opened_at: string
  expires_at: string
  /** QR rotation period in seconds, chosen by the admin at session start. */
  window_seconds: number
}

export type AttendanceRow = {
  session_id: string
  student_id: string
  marked_at: string
  device_id: string | null
  source: 'scan' | 'manual'
}

export type LoginAttemptRow = {
  id: number
  caller: string
  at: string
}

export type StudentCredentialRow = {
  id: string
  student_id: string
  /** base64url of the raw credential id. */
  credential_id: string
  /** base64url COSE public key. */
  public_key: string
  counter: number
  transports: string[] | null
  device_label: string | null
  created_at: string
  last_used_at: string | null
}

export type WebAuthnChallengeRow = {
  challenge: string
  purpose: 'register' | 'authenticate'
  /** Set for registration; null for discoverable authentication. */
  student_id: string | null
  created_at: string
  expires_at: string
}

export type AdminGrantRow = {
  id: string
  label: string
  code_hash: string
  expires_at: string
  revoked_at: string | null
  last_used_at: string | null
  created_at: string
}

export type AuditAction =
  | 'OVERRIDE_MARK'
  | 'OVERRIDE_UNMARK'
  | 'RESET_DEVICE'
  | 'START_SESSION'
  | 'START_BACKDATED_SESSION'
  | 'OPEN_SESSION'
  | 'CLOSE_SESSION'
  | 'GRANT_ISSUED'
  | 'GRANT_REVOKED'
  | 'EXPORT'
  | 'CLAIM_DEVICE'
  | 'ADD_STUDENT'
  | 'PASSKEY_REGISTERED'
  | 'PASSKEY_REMOVED'

export type AuditLogRow = {
  id: number
  at: string
  action: AuditAction
  student_id: string | null
  session_id: string | null
  reason: string | null
  /** 'primary', or 'deputy:<label>'. */
  actor: string | null
}

type Table<Row, Insert = Partial<Row>, Update = Partial<Row>> = {
  Row: Row
  Insert: Insert
  Update: Update
  Relationships: []
}

export type Database = {
  public: {
    Tables: {
      students: Table<StudentRow, Omit<StudentRow, 'id'> & { id?: string }>
      sessions: Table<
        SessionRow,
        Omit<SessionRow, 'id' | 'opened_at' | 'window_seconds'> & {
          id?: string
          opened_at?: string
          window_seconds?: number
        }
      >
      // device_id is optional on insert: passkey marks do not write it, since a
      // credential is not a device. See src/lib/mark.ts.
      attendance: Table<
        AttendanceRow,
        Omit<AttendanceRow, 'marked_at' | 'device_id'> & {
          marked_at?: string
          device_id?: string | null
        }
      >
      login_attempts: Table<
        LoginAttemptRow,
        Omit<LoginAttemptRow, 'id' | 'at'> & { id?: number; at?: string }
      >
      audit_log: Table<AuditLogRow, Omit<AuditLogRow, 'id' | 'at'> & { id?: number; at?: string }>
      student_credentials: Table<
        StudentCredentialRow,
        Omit<StudentCredentialRow, 'id' | 'created_at' | 'last_used_at' | 'counter'> & {
          id?: string
          created_at?: string
          last_used_at?: string | null
          counter?: number
        }
      >
      webauthn_challenges: Table<
        WebAuthnChallengeRow,
        Omit<WebAuthnChallengeRow, 'created_at'> & { created_at?: string }
      >
      admin_grants: Table<
        AdminGrantRow,
        Omit<AdminGrantRow, 'id' | 'created_at' | 'revoked_at' | 'last_used_at'> & {
          id?: string
          created_at?: string
          revoked_at?: string | null
          last_used_at?: string | null
        }
      >
    }
    Views: Record<never, never>
    Functions: Record<never, never>
    Enums: Record<never, never>
    CompositeTypes: Record<never, never>
  }
}
