/**
 * Seeds `students` from the instructor's spreadsheet.
 *
 *   npm run seed -- "Soft Skills.xlsx"
 *
 * Idempotent: it upserts on roll_no, so re-running after a name correction in
 * the sheet updates the row without touching device bindings or attendance.
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import ExcelJS from 'exceljs'
import path from 'node:path'
import type { Database } from '../src/lib/database.types'

config({ path: ['.env.local', '.env'], quiet: true })

const FIRST_ROW = 2
const LAST_ROW = 48

async function main() {
  const file = process.argv[2] ?? 'Soft Skills.xlsx'
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error(
      'Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local first.'
    )
  }

  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(path.resolve(file))
  const ws = wb.worksheets[0]

  const students: Database['public']['Tables']['students']['Insert'][] = []
  const seenRolls = new Set<string>()

  for (let r = FIRST_ROW; r <= LAST_ROW; r++) {
    const rollNo = ws.getCell(`B${r}`).text.trim()
    const name = ws.getCell(`C${r}`).text.trim()
    const email = ws.getCell(`D${r}`).text.trim()
    if (!rollNo) {
      console.warn(`row ${r}: no roll number, skipped`)
      continue
    }
    if (seenRolls.has(rollNo)) {
      throw new Error(`row ${r}: duplicate roll number ${rollNo} — fix the sheet first`)
    }
    seenRolls.add(rollNo)

    students.push({
      s_no: r - FIRST_ROW + 1,
      roll_no: rollNo,
      name,
      email: email || null,
    })
  }

  console.log(`read ${students.length} students from ${file}`)

  const db = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: existing, error: readError } = await db.from('students').select('roll_no, s_no')
  if (readError) throw readError
  const bySeenRoll = new Map((existing ?? []).map((r) => [r.roll_no, r.s_no]))

  const fresh = students.filter((s) => !bySeenRoll.has(s.roll_no))
  if (fresh.length) {
    const { error } = await db.from('students').insert(fresh)
    if (error) throw error
    console.log(`inserted ${fresh.length} new students`)
  }

  const known = students.filter((s) => bySeenRoll.has(s.roll_no))
  const reordered = known.filter((s) => bySeenRoll.get(s.roll_no) !== s.s_no)

  // s_no is unique, so assigning new positions in place can collide with a row
  // that has not been moved yet. Park every affected row on a negative number
  // first — negatives are unique among themselves — then write the real values.
  if (reordered.length) {
    for (const s of reordered) {
      const { error } = await db
        .from('students')
        .update({ s_no: -(bySeenRoll.get(s.roll_no) as number) })
        .eq('roll_no', s.roll_no)
      if (error) throw error
    }
  }

  for (const s of known) {
    const { error } = await db
      .from('students')
      .update({ s_no: s.s_no, name: s.name, email: s.email })
      .eq('roll_no', s.roll_no)
    if (error) throw error
  }
  console.log(`refreshed ${known.length} existing students (${reordered.length} reordered)`)

  const { count, error: countError } = await db
    .from('students')
    .select('*', { count: 'exact', head: true })
  if (countError) throw countError
  console.log(`students table now holds ${count} rows`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
