import ExcelJS from 'exceljs'
import { randomBytes } from 'node:crypto'

/**
 * The instructor's file is Calibri 11; the build spec asks for Arial. Spec wins,
 * but it is one constant so it can be flipped back without touching layout code.
 */
const FONT_NAME = 'Arial'
const FONT_SIZE = 11

/** Column A..E are fixed; the date block starts at F. */
const FIRST_DATE_COL = 6 // F
/** The original sheet reserves F..U — sixteen class days. */
const RESERVED_DATE_COLS = 16

const PRESENT_MARK = '✓'
/** Matches the original file's `[$-14009]d/m/yy;@`. */
const DATE_FORMAT = '[$-14009]d/m/yy;@'
const PERCENT_FORMAT = '0.0%'

export type ExportStudent = {
  s_no: number
  roll_no: string
  name: string
  email: string | null
}

export type ExportSession = { id: string; class_date: string }

export function columnLetter(index: number): string {
  let n = index
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

const thin = { style: 'thin' as const }
const border = { top: thin, left: thin, bottom: thin, right: thin }

/**
 * Reproduces the instructor's sheet: S.No / Roll NO. / Name / Mail Id / Date:,
 * one column per session from F, then live COUNTIF and percentage formulas.
 *
 * The `source` of a mark is deliberately not represented — scanned and manual
 * both write a plain ✓, because this file has to stay diffable against the one
 * the instructor already keeps.
 */
export type ViewOnly = {
  /** Who the copy was issued to, named on a second sheet. */
  issuedTo: string
  issuedAt: Date
  range?: { from?: string; to?: string }
}

export async function buildWorkbook(
  students: ExportStudent[],
  sessions: ExportSession[],
  presentByStudent: Map<number, Set<string>>,
  viewOnly?: ViewOnly
): Promise<Buffer> {
  const ordered = [...sessions].sort((a, b) => a.class_date.localeCompare(b.class_date))

  // Normally the dates fit F..U exactly as in the original. If a semester runs
  // past sixteen classes we widen the block and push the totals right rather
  // than silently dropping the extra days.
  const dateCols = Math.max(ordered.length, RESERVED_DATE_COLS)
  const lastDateCol = FIRST_DATE_COL + dateCols - 1
  const totalCol = lastDateCol + 1
  const pctCol = totalCol + 1

  const firstL = columnLetter(FIRST_DATE_COL)
  const lastL = columnLetter(lastDateCol)
  const totalL = columnLetter(totalCol)

  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet3')

  ws.columns = [
    { width: 5.57 },
    { width: 11.86 },
    { width: 37.71 },
    { width: 35.57 },
    { width: 5 },
    { width: 7.43 },
    ...Array.from({ length: dateCols - 1 }, () => ({ width: 9.14 })),
    { width: 10.71 },
    { width: 9.14 },
  ]

  const header = ws.getRow(1)
  const setHeader = (col: number, value: string | Date, opts: { small?: boolean } = {}) => {
    const cell = header.getCell(col)
    cell.value = value
    cell.font = {
      name: FONT_NAME,
      size: opts.small ? 9 : FONT_SIZE,
      bold: true,
    }
    cell.border = border
    if (opts.small) cell.alignment = { wrapText: true }
    return cell
  }

  setHeader(1, 'S.No')
  setHeader(2, 'Roll NO.')
  setHeader(3, 'Name ') // trailing space is in the original
  setHeader(4, 'Mail Id')
  setHeader(5, 'Date:')

  ordered.forEach((session, i) => {
    const cell = setHeader(FIRST_DATE_COL + i, excelDate(session.class_date))
    cell.numFmt = DATE_FORMAT
  })

  setHeader(totalCol, 'Total \nAttendnacs', { small: true })
  setHeader(pctCol, 'Attendnacs \n%', { small: true })

  students
    .slice()
    .sort((a, b) => a.s_no - b.s_no)
    .forEach((student, i) => {
      const rowNo = i + 2
      const row = ws.getRow(rowNo)
      const present = presentByStudent.get(student.s_no) ?? new Set<string>()

      const write = (col: number, value: ExcelJS.CellValue) => {
        const cell = row.getCell(col)
        cell.value = value
        cell.font = { name: FONT_NAME, size: FONT_SIZE }
        cell.border = border
        return cell
      }

      write(1, student.s_no).alignment = { horizontal: 'center' }
      write(2, student.roll_no)
      write(3, student.name)
      write(4, student.email ?? '')
      write(5, null)

      for (let c = FIRST_DATE_COL; c <= lastDateCol; c++) {
        const session = ordered[c - FIRST_DATE_COL]
        write(c, session && present.has(session.id) ? PRESENT_MARK : null).alignment = {
          horizontal: 'center',
        }
      }

      // Live formulas, not computed values: the instructor edits this file by
      // hand afterwards and the totals have to keep up.
      write(totalCol, {
        formula: `COUNTIF(${firstL}${rowNo}:${lastL}${rowNo},"${PRESENT_MARK}")`,
      }).alignment = { horizontal: 'center' }

      const pct = write(pctCol, {
        formula:
          `IF(COUNT($${firstL}$1:$${lastL}$1)=0,"",` +
          `${totalL}${rowNo}/COUNT($${firstL}$1:$${lastL}$1))`,
      })
      pct.numFmt = PERCENT_FORMAT
      pct.alignment = { horizontal: 'center' }
    })

  ws.views = [{ state: 'frozen', xSplit: 4, ySplit: 1 }]

  if (viewOnly) await applyViewOnly(wb, ws, viewOnly)

  const out = await wb.xlsx.writeBuffer()
  return Buffer.from(out)
}

/**
 * Marks a copy as read-only for someone holding temporary access.
 *
 * Worth being precise about what this is: sheet protection stops accidental
 * edits in Excel's UI, and the second sheet plus document metadata record who
 * the copy went to. It is **not** access control — anyone determined can strip
 * it by unzipping the file or pasting the cells into a fresh workbook. The real
 * control is that their access expires and the copy is attributable.
 *
 * The grid on sheet 1 is left untouched, so a view-only copy still matches the
 * instructor's own layout cell for cell.
 */
async function applyViewOnly(
  wb: ExcelJS.Workbook,
  ws: ExcelJS.Worksheet,
  viewOnly: ViewOnly
): Promise<void> {
  const stamp = viewOnly.issuedAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  const span =
    viewOnly.range?.from || viewOnly.range?.to
      ? `${viewOnly.range.from ?? 'start of term'} to ${viewOnly.range.to ?? 'today'}`
      : 'whole term'

  wb.creator = 'QR Attendance'
  wb.lastModifiedBy = `read-only copy for ${viewOnly.issuedTo}`
  wb.description = `Read-only copy issued to ${viewOnly.issuedTo} at ${stamp}. Range: ${span}.`

  const notes = wb.addWorksheet('Issued')
  notes.columns = [{ width: 18 }, { width: 62 }]
  const rows: [string, string][] = [
    ['Read-only copy', 'Generated from the attendance database. Do not edit.'],
    ['Issued to', viewOnly.issuedTo],
    ['Issued at', stamp],
    ['Range', span],
    ['Source of truth', 'The attendance database, not this file.'],
  ]
  rows.forEach(([label, value], i) => {
    const row = notes.getRow(i + 1)
    row.getCell(1).value = label
    row.getCell(1).font = { name: FONT_NAME, size: FONT_SIZE, bold: true }
    row.getCell(2).value = value
    row.getCell(2).font = { name: FONT_NAME, size: FONT_SIZE }
  })

  // A password nobody is handed: the point is that the cells cannot be edited
  // in place, not that anyone will ever unlock them.
  const lock = randomBytes(16).toString('hex')
  await ws.protect(lock, {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatCells: false,
    formatColumns: false,
    formatRows: false,
    insertRows: false,
    insertColumns: false,
    deleteRows: false,
    deleteColumns: false,
    sort: false,
    autoFilter: false,
  })
  await notes.protect(lock, { selectLockedCells: true })
}

/**
 * A date-only value as Excel sees it. Built in UTC so the serial does not shift
 * by a day depending on where the server runs.
 */
export function excelDate(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00Z`)
}

export function exportFilename(prefix: string, at: Date = new Date()): string {
  return `${prefix}-${at.toISOString().slice(0, 10)}.xlsx`
}

export { FIRST_DATE_COL, PRESENT_MARK, RESERVED_DATE_COLS }
