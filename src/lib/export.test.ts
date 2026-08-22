import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { buildWorkbook, columnLetter, type ExportSession, type ExportStudent } from './export'

const STUDENTS: ExportStudent[] = [
  { s_no: 1, roll_no: 'MT2026002', name: 'Ujalambkar Aditya Jayantrao', email: 'aditya.ujalambkar@iiitb.ac.in' },
  { s_no: 2, roll_no: 'MT2026008', name: 'Anmol Nayyar', email: 'anmol.nayyar@iiitb.ac.in' },
  { s_no: 3, roll_no: 'MT2026020', name: 'Dev Kumar', email: null },
]

const SESSIONS: ExportSession[] = [
  { id: 's-aug21', class_date: '2026-08-21' },
  { id: 's-aug14', class_date: '2026-08-14' }, // deliberately out of order
]

async function build(
  students = STUDENTS,
  sessions = SESSIONS,
  present = new Map([
    [1, new Set(['s-aug21', 's-aug14'])],
    [2, new Set(['s-aug21'])],
  ])
) {
  const buf = await buildWorkbook(students, sessions, present)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf as unknown as ArrayBuffer)
  return wb.worksheets[0]
}

describe('columnLetter', () => {
  it('maps 1-based indices to spreadsheet columns', () => {
    expect([1, 5, 6, 21, 22, 23, 26, 27, 28].map(columnLetter)).toEqual([
      'A', 'E', 'F', 'U', 'V', 'W', 'Z', 'AA', 'AB',
    ])
  })
})

describe('roster export layout', () => {
  it('reproduces the original header row, trailing space and all', async () => {
    const ws = await build()
    expect(ws.getCell('A1').value).toBe('S.No')
    expect(ws.getCell('B1').value).toBe('Roll NO.')
    expect(ws.getCell('C1').value).toBe('Name ')
    expect(ws.getCell('D1').value).toBe('Mail Id')
    expect(ws.getCell('E1').value).toBe('Date:')
    expect(ws.getCell('V1').value).toBe('Total \nAttendnacs')
    expect(ws.getCell('W1').value).toBe('Attendnacs \n%')
  })

  it('writes session dates from F onward, ascending, as real Excel dates', async () => {
    const ws = await build()
    const f1 = ws.getCell('F1').value
    const g1 = ws.getCell('G1').value
    expect(f1).toBeInstanceOf(Date)
    expect(g1).toBeInstanceOf(Date)
    expect((f1 as Date).toISOString().slice(0, 10)).toBe('2026-08-14')
    expect((g1 as Date).toISOString().slice(0, 10)).toBe('2026-08-21')
    expect(ws.getCell('H1').value).toBeNull()
  })

  it('stores 21 Aug 2026 as serial 46255, matching the original file', async () => {
    const buf = await buildWorkbook(STUDENTS, [SESSIONS[0]], new Map())
    // Read the raw sheet XML: exceljs hands back Dates, but Excel stores serials.
    const { default: JSZip } = await import('jszip')
    const zip = await JSZip.loadAsync(buf)
    const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
    const f1 = /<c r="F1"[^>]*>(?:<f>.*?<\/f>)?<v>([^<]+)<\/v>/.exec(xml)
    expect(f1?.[1]).toBe('46255')
  })

  it('leaves E blank for every student — it is a label, not data', async () => {
    const ws = await build()
    for (const row of [2, 3, 4]) expect(ws.getCell(`E${row}`).value).toBeNull()
  })

  it('puts students in S.No order with roll, name and mail', async () => {
    const ws = await build()
    expect(ws.getCell('A2').value).toBe(1)
    expect(ws.getCell('B2').value).toBe('MT2026002')
    expect(ws.getCell('C2').value).toBe('Ujalambkar Aditya Jayantrao')
    expect(ws.getCell('D2').value).toBe('aditya.ujalambkar@iiitb.ac.in')
    expect(ws.getCell('B4').value).toBe('MT2026020')
    expect(ws.getCell('D4').value).toBe('') // null email is an empty cell, not "null"
  })

  it('marks ✓ only where an attendance row exists', async () => {
    const ws = await build()
    // F = 14 Aug, G = 21 Aug after sorting.
    expect(ws.getCell('F2').value).toBe('✓')
    expect(ws.getCell('G2').value).toBe('✓')
    expect(ws.getCell('F3').value).toBeNull() // Anmol missed the 14th
    expect(ws.getCell('G3').value).toBe('✓')
    expect(ws.getCell('F4').value).toBeNull()
    expect(ws.getCell('G4').value).toBeNull()
  })

  it('writes plain ✓ for manual marks too — provenance stays out of the file', async () => {
    // The builder is given only "present or not"; there is no channel for source.
    const ws = await build(STUDENTS, [SESSIONS[0]], new Map([[3, new Set(['s-aug21'])]]))
    expect(ws.getCell('F4').value).toBe('✓')
  })

  it('keeps V and W as live formulas over the full F:U range', async () => {
    const ws = await build()
    expect((ws.getCell('V2').value as { formula: string }).formula).toBe(
      'COUNTIF(F2:U2,"✓")'
    )
    expect((ws.getCell('W2').value as { formula: string }).formula).toBe(
      'IF(COUNT($F$1:$U$1)=0,"",V2/COUNT($F$1:$U$1))'
    )
    expect((ws.getCell('V4').value as { formula: string }).formula).toBe(
      'COUNTIF(F4:U4,"✓")'
    )
  })

  it('formats the percentage column as 0.0%', async () => {
    const ws = await build()
    expect(ws.getCell('W2').numFmt).toBe('0.0%')
  })

  it('uses Arial throughout', async () => {
    const ws = await build()
    for (const ref of ['A1', 'C1', 'V1', 'A2', 'C2', 'F2', 'W2']) {
      expect(ws.getCell(ref).font?.name).toBe('Arial')
    }
  })

  it('bolds the header row only', async () => {
    const ws = await build()
    expect(ws.getCell('A1').font?.bold).toBe(true)
    expect(ws.getCell('A2').font?.bold).toBeFalsy()
  })

  it('spans exactly A1:W48 for the real 47-student roster', async () => {
    const roster = Array.from({ length: 47 }, (_, i) => ({
      s_no: i + 1,
      roll_no: `MT${2026000 + i}`,
      name: `Student ${i + 1}`,
      email: `s${i + 1}@iiitb.ac.in`,
    }))
    const ws = await build(roster, SESSIONS, new Map())
    expect(ws.rowCount).toBe(48)
    expect(ws.columnCount).toBe(23) // W
  })

  it('has no date columns to fill when no session has happened yet', async () => {
    const ws = await build(STUDENTS, [], new Map())
    expect(ws.getCell('F1').value).toBeNull()
    expect(ws.getCell('V1').value).toBe('Total \nAttendnacs')
    // W then evaluates to "" in Excel rather than dividing by zero.
    expect((ws.getCell('W2').value as { formula: string }).formula).toContain(
      'COUNT($F$1:$U$1)=0'
    )
  })

  it('widens the block past U rather than dropping a 17th class', async () => {
    const many = Array.from({ length: 18 }, (_, i) => ({
      id: `s-${i}`,
      class_date: `2026-09-${String(i + 1).padStart(2, '0')}`,
    }))
    const ws = await build(STUDENTS, many, new Map([[1, new Set(['s-17'])]]))
    expect(ws.getCell('W1').value).toBeInstanceOf(Date) // 18th date sits in W
    expect(ws.getCell('X1').value).toBe('Total \nAttendnacs')
    expect((ws.getCell('X2').value as { formula: string }).formula).toBe(
      'COUNTIF(F2:W2,"✓")'
    )
    // s-0 sits in F, so s-17 (the 18th class) is column W.
    expect(ws.getCell('W2').value).toBe('✓')
    expect(ws.getCell('V2').value).toBeNull()
  })
})

describe('view-only copies for temporary access', () => {
  const issued = { issuedTo: 'Anita (TA)', issuedAt: new Date('2026-08-21T09:30:00Z') }

  async function buildViewOnly() {
    const buf = await buildWorkbook(
      STUDENTS,
      SESSIONS,
      new Map([[1, new Set(['s-aug21'])]]),
      issued
    )
    const { default: JSZip } = await import('jszip')
    const zip = await JSZip.loadAsync(buf)
    return {
      sheet: await zip.file('xl/worksheets/sheet1.xml')!.async('string'),
      core: await zip.file('docProps/core.xml')!.async('string'),
      shared: await zip.file('xl/sharedStrings.xml')!.async('string'),
      names: Object.keys(zip.files),
      buf,
    }
  }

  it('locks the sheet against casual editing', async () => {
    const { sheet } = await buildViewOnly()
    expect(sheet).toContain('<sheetProtection')
    // Hashed, so the lock cannot be read back out of the file.
    expect(sheet).toContain('algorithmName="SHA-512"')
  })

  it('keeps V and W recalculating under protection', async () => {
    const { sheet } = await buildViewOnly()
    expect(sheet).toContain('COUNTIF(F2:U2')
    expect(sheet).toContain('COUNT($F$1:$U$1)')
  })

  it('names who the copy went to, on a second sheet', async () => {
    const { names, shared } = await buildViewOnly()
    expect(names).toContain('xl/worksheets/sheet2.xml')
    expect(shared).toContain('Anita (TA)')
    expect(shared).toContain('Issued to')
  })

  it('records provenance in the document metadata too', async () => {
    const { core } = await buildViewOnly()
    expect(core).toContain('Anita (TA)')
    expect(core).toContain('Read-only copy')
  })

  it('leaves the register grid identical to the instructor\'s own copy', async () => {
    // Same inputs, with and without the view-only stamp: row 2 must match.
    const plain = await buildWorkbook(
      STUDENTS,
      SESSIONS,
      new Map([[1, new Set(['s-aug21'])]])
    )
    const { default: JSZip } = await import('jszip')
    const a = await (await JSZip.loadAsync(plain)).file('xl/worksheets/sheet1.xml')!.async('string')
    const { sheet: b } = await buildViewOnly()
    const rowOf = (xml: string, n: number) =>
      new RegExp(`<row r="${n}"[^>]*>.*?</row>`, 's').exec(xml)?.[0]
    expect(rowOf(b, 1)).toBe(rowOf(a, 1))
    expect(rowOf(b, 2)).toBe(rowOf(a, 2))
  })

  it('produces no protection or extra sheet for the instructor', async () => {
    const buf = await buildWorkbook(STUDENTS, SESSIONS, new Map())
    const { default: JSZip } = await import('jszip')
    const zip = await JSZip.loadAsync(buf)
    const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
    expect(sheet).not.toContain('<sheetProtection')
    expect(Object.keys(zip.files)).not.toContain('xl/worksheets/sheet2.xml')
  })
})
