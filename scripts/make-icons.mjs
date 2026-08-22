/**
 * Generates the PWA and iOS home-screen icons.
 *
 *   node scripts/make-icons.mjs
 *
 * Hand-rolled PNG encoder rather than a dependency: the artwork is a tick on a
 * rounded square, which is a few dozen lines of pixel maths and not worth
 * pulling an image library into the build for.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const INK = [15, 82, 61] // deep green, the register's tick colour
const MARK = [255, 255, 255]

function crc32(buf) {
  let c = ~0
  for (const byte of buf) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** Signed distance from a point to a segment, for drawing the tick with width. */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx
  const cy = ay + t * dy
  return Math.hypot(px - cx, py - cy)
}

function render(size, { padded }) {
  // A maskable icon needs its artwork inside the safe circle, so the tick is
  // drawn smaller when the platform may crop the edges.
  const inset = padded ? size * 0.22 : size * 0.12
  const radius = padded ? size / 2 : size * 0.22
  const stroke = size * (padded ? 0.085 : 0.1)

  // Tick geometry, in unit space then scaled into the inset box.
  const box = size - inset * 2
  const p = (fx, fy) => [inset + fx * box, inset + fy * box]
  const [ax, ay] = p(0.1, 0.54)
  const [bx, by] = p(0.4, 0.8)
  const [cx, cy] = p(0.9, 0.22)

  const rows = []
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4)
    row[0] = 0 // no filter
    for (let x = 0; x < size; x++) {
      const o = 1 + x * 4

      // Rounded-square (or circle) coverage for the background.
      let inside
      if (padded) {
        inside = Math.hypot(x - size / 2, y - size / 2) <= radius
      } else {
        const dx = Math.max(radius - x, x - (size - radius), 0)
        const dy = Math.max(radius - y, y - (size - radius), 0)
        inside = Math.hypot(dx, dy) <= radius
      }
      if (!inside) {
        row[o] = row[o + 1] = row[o + 2] = row[o + 3] = 0
        continue
      }

      const d = Math.min(
        distToSegment(x, y, ax, ay, bx, by),
        distToSegment(x, y, bx, by, cx, cy)
      )
      // Antialias the tick edge over one pixel.
      const t = Math.max(0, Math.min(1, (stroke / 2 - d) / 1.2 + 0.5))
      row[o] = Math.round(INK[0] + (MARK[0] - INK[0]) * t)
      row[o + 1] = Math.round(INK[1] + (MARK[1] - INK[1]) * t)
      row[o + 2] = Math.round(INK[2] + (MARK[2] - INK[2]) * t)
      row[o + 3] = 255
    }
    rows.push(row)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const targets = [
  ['public/icon-192.png', 192, { padded: false }],
  ['public/icon-512.png', 512, { padded: false }],
  ['public/icon-maskable-512.png', 512, { padded: true }],
  // iOS composites its own rounded corners and no transparency, so the
  // apple-touch-icon is the square variant.
  ['public/apple-touch-icon.png', 180, { padded: false }],
  ['public/favicon-32.png', 32, { padded: false }],
]

for (const [path, size, opts] of targets) {
  const png = render(size, opts)
  writeFileSync(path, png)
  console.log(`${path.padEnd(34)} ${size}x${size}  ${(png.length / 1024).toFixed(1)}KB`)
}
