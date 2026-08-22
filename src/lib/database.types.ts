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
  reset_allowed: boolean
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

export type SettingRow = { key: string; value: string }

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
  | 'OPEN_ENROLLMENT'
  | 'CLOSE_ENROLLMENT'
  | 'START_SESSION'
  | 'START_BACKDATED_SESSION'
  | 'OPEN_SESSION'
  | 'CLOSE_SESSION'
  | 'GRANT_ISSUED'
  | 'GRANT_REVOKED'
  | 'EXPORT'
  | 'CLAIM_DEVICE'

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
      attendance: Table<AttendanceRow, Omit<AttendanceRow, 'marked_at'> & { marked_at?: string }>
      settings: Table<SettingRow, SettingRow>
      audit_log: Table<AuditLogRow, Omit<AuditLogRow, 'id' | 'at'> & { id?: number; at?: string }>
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
