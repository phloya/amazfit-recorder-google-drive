// Рисует иконку приложения (красная точка записи на тёмном круге) без сторонних библиотек.
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const SIZE = 248 // минимум по требованиям Zepp OS
const out = path.join(__dirname, '..', 'assets', 'common.r', 'icon.png')

function crc32(buf) {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
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

// Плавный край: доля пикселя внутри круга радиуса r
function coverage(d, r) {
  return Math.max(0, Math.min(1, r - d + 0.5))
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
const c = (SIZE - 1) / 2
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0
  for (let x = 0; x < SIZE; x++) {
    const d = Math.hypot(x - c, y - c)
    const outer = coverage(d, SIZE / 2 - 1)
    const ring = coverage(d, SIZE * 0.36) - coverage(d, SIZE * 0.31)
    const dot = coverage(d, SIZE * 0.24)
    let r = 0x1c, g = 0x1c, b = 0x1e
    // светлое кольцо
    r += (0xe5 - r) * ring; g += (0xe5 - g) * ring; b += (0xea - b) * ring
    // красная точка
    r += (0xff - r) * dot; g += (0x3b - g) * dot; b += (0x30 - b) * dot
    const i = y * (SIZE * 4 + 1) + 1 + x * 4
    raw[i] = Math.round(r)
    raw[i + 1] = Math.round(g)
    raw[i + 2] = Math.round(b)
    raw[i + 3] = Math.round(255 * outer)
  }
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // бит на канал
ihdr[9] = 6 // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, png)
console.log('icon:', out, png.length, 'bytes')
