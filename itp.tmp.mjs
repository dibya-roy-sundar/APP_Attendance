import { webkit, devices } from 'playwright'
import { createHmac } from 'node:crypto'
import { one, select, remove, patch } from './test/local/db.mjs'
const B='http://127.0.0.1:3100'
await remove('attendance','session_id=not.is.null'); await remove('sessions','id=not.is.null')
await remove('audit_log','id=gt.0'); await remove('login_attempts','id=gt.0')
await patch('students','id=not.is.null',{device_id:null,enrolled_at:null})
const r=await fetch(`${B}/api/admin/login`,{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({password:process.env.ADMIN_PASSWORD})})
const jar=(r.headers.getSetCookie?.()??[]).map(c=>c.split(';')[0]).join('; ')
await fetch(`${B}/api/sessions`,{method:'POST',headers:{'Content-Type':'application/json',cookie:jar},
  body:JSON.stringify({minutes:60,windowSeconds:15})})
const s=await one('sessions','select=id,secret,window_seconds&order=opened_at.desc&limit=1')
const url=()=>`${B}/m?s=${s.id}&t=${createHmac('sha256',s.secret).update(`${s.id}:${Math.floor(Date.now()/1000/s.window_seconds)}`).digest('base64url').slice(0,12)}`
const roster=await select('students','select=roll_no,name&order=s_no.asc')

const br=await webkit.launch()
const ctx=await br.newContext({...devices['iPhone 14']})
const p=await ctx.newPage()

console.log('WEEK 1 — student registers normally')
await p.goto(url(),{waitUntil:'networkidle'})
await p.getByLabel('Roll number').fill(roster[0].roll_no)
await p.getByRole('button',{name:/Register and mark present/}).click()
await p.waitForSelector('text=Present',{timeout:20000})
console.log('  marked present as', roster[0].name)
const stored = await p.evaluate(()=>localStorage.getItem('att_device'))
console.log('  att_device in localStorage:', stored?.slice(0,8)+'…')
console.log('  device_id in the database :', (await one('students',`select=device_id&roll_no=eq.${roster[0].roll_no}`)).device_id?.slice(0,8)+'…')

console.log('\nWEEK 2 — Safari has purged script-writable storage (ITP 7-day cap)')
await p.evaluate(()=>localStorage.clear())
console.log('  localStorage now:', await p.evaluate(()=>localStorage.getItem('att_device')))
console.log('  but the database still binds their old id\n')
await p.goto(url(),{waitUntil:'networkidle'})
await p.waitForTimeout(800)
console.log('  the student sees:')
console.log('   ', (await p.locator('body').innerText()).replace(/\s+/g,' ').slice(0,180))

console.log('\n  they try their roll number again:')
const box = p.getByLabel('Roll number')
if (await box.count()) {
  await box.fill(roster[0].roll_no)
  await p.getByRole('button',{name:/Register and mark present/}).click()
  await p.waitForTimeout(1500)
  console.log('   ', (await p.locator('body').innerText()).replace(/\s+/g,' ').slice(0,200))
} else console.log('    (no roll-number field offered)')
await br.close()
