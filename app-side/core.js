// Логика телефона без привязки к Zepp OS: разбор записи с часов, упаковка в Ogg Opus,
// выгрузка в Google Drive кусками. Модуль одинаково работает в Zepp App и в Node (тесты).

export const PRE_SKIP = 312 // задержка кодера Opus в отсчётах 48 кГц (стандарт libopus)
export const INPUT_RATE = 16000 // часы пишут 16 кГц моно
export const DRIVE_ALIGN = 256 * 1024 // Drive принимает куски, кратные 256 КиБ (кроме последнего)
export const UPLOAD_PIECE = 2 * DRIVE_ALIGN // отправляем по 512 КиБ (≈700 КБ в base64 на запрос)

// ---------- байты ----------

export function concatBytes(list, total) {
  if (total === undefined) total = list.reduce((s, a) => s + a.length, 0)
  const out = new Uint8Array(total)
  let pos = 0
  for (const a of list) {
    out.set(a, pos)
    pos += a.length
  }
  return out
}

function u16le(buf, pos, v) {
  buf[pos] = v & 255
  buf[pos + 1] = (v >>> 8) & 255
}

function u32le(buf, pos, v) {
  buf[pos] = v & 255
  buf[pos + 1] = (v >>> 8) & 255
  buf[pos + 2] = (v >>> 16) & 255
  buf[pos + 3] = (v >>> 24) & 255
}

function ascii(str) {
  const out = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 255
  return out
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function toBase64(u8) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64')
  }
  const parts = []
  let i = 0
  const n = u8.length
  for (; i + 2 < n; i += 3) {
    const v = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2]
    parts.push(B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63])
  }
  if (i < n) {
    const two = i + 1 < n
    const v = (u8[i] << 16) | ((two ? u8[i + 1] : 0) << 8)
    parts.push(B64[v >> 18] + B64[(v >> 12) & 63] + (two ? B64[(v >> 6) & 63] : '=') + '=')
  }
  return parts.join('')
}

// ---------- CRC32 для Ogg (полином 0x04C11DB7, без отражения) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let r = i << 24
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1
    t[i] = r >>> 0
  }
  return t
})()

export function oggCrc(buf) {
  let crc = 0
  for (let i = 0; i < buf.length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ buf[i]) & 255]) >>> 0
  }
  return crc
}

// ---------- Opus ----------

// Длительность пакета Opus в отсчётах 48 кГц по байту TOC (RFC 6716, раздел 3.1).
export function opusPacketSamples(p) {
  if (!p.length) return 0
  const toc = p[0]
  const config = toc >> 3
  let frame
  if (config < 12) frame = [480, 960, 1920, 2880][config & 3]
  else if (config < 16) frame = config & 1 ? 960 : 480
  else frame = [120, 240, 480, 960][config & 3]
  const c = toc & 3
  const count = c === 0 ? 1 : c === 3 ? (p.length > 1 ? p[1] & 63 : 0) : 2
  return frame * count
}

// Файл с часов: пакеты подряд, у каждого заголовок 8 байт —
// длина (uint32, big-endian) и 4 служебных байта (формат opus_demo).
export class ZeppOpusParser {
  constructor() {
    this.pending = new Uint8Array(0)
    this.packets = 0
  }

  push(chunk) {
    const buf = this.pending.length ? concatBytes([this.pending, chunk]) : chunk
    const out = []
    let pos = 0
    while (buf.length - pos >= 8) {
      const len = buf[pos] * 16777216 + (buf[pos + 1] << 16) + (buf[pos + 2] << 8) + buf[pos + 3]
      if (len > 65535) {
        throw new Error('битый пакет Opus #' + this.packets + ': длина ' + len)
      }
      if (buf.length - pos < 8 + len) break
      out.push(buf.slice(pos + 8, pos + 8 + len))
      pos += 8 + len
      this.packets++
    }
    this.pending = buf.slice(pos)
    return out
  }
}

// Ogg Opus (RFC 7845) потоком: страницы отдаются в onPage по мере заполнения.
export class OggOpusWriter {
  constructor(serial, onPage) {
    this.serial = serial >>> 0
    this.onPage = onPage
    this.seq = 0
    this.granule = 0
    this.packets = []
    this.segments = 0
    this.size = 0
    this.finished = false

    const head = new Uint8Array(19)
    head.set(ascii('OpusHead'), 0)
    head[8] = 1 // версия
    head[9] = 1 // каналов
    u16le(head, 10, PRE_SKIP)
    u32le(head, 12, INPUT_RATE)
    u16le(head, 16, 0) // усиление
    head[18] = 0 // раскладка каналов
    this._page([head], 0x02, 0)

    const vendor = ascii('amazfit-recorder')
    const tags = new Uint8Array(8 + 4 + vendor.length + 4)
    tags.set(ascii('OpusTags'), 0)
    u32le(tags, 8, vendor.length)
    tags.set(vendor, 12)
    u32le(tags, 12 + vendor.length, 0)
    this._page([tags], 0x00, 0)
  }

  get durationSec() {
    return Math.max(0, this.granule - PRE_SKIP) / 48000
  }

  add(packet) {
    if (!packet.length) return
    const segs = Math.floor(packet.length / 255) + 1
    if (this.packets.length && (this.segments + segs > 255 || this.size + packet.length > 8192)) {
      this._flush(false)
    }
    this.packets.push(packet)
    this.segments += segs
    this.size += packet.length
    this.granule += opusPacketSamples(packet)
  }

  finish() {
    if (this.finished) return
    this.finished = true
    this._flush(true)
  }

  _flush(eos) {
    this._page(this.packets, eos ? 0x04 : 0x00, this.granule)
    this.packets = []
    this.segments = 0
    this.size = 0
  }

  _page(packets, flags, granule) {
    const lacing = []
    let dataLen = 0
    for (const p of packets) {
      let n = p.length
      while (n >= 255) {
        lacing.push(255)
        n -= 255
      }
      lacing.push(n)
      dataLen += p.length
    }
    const page = new Uint8Array(27 + lacing.length + dataLen)
    page.set(ascii('OggS'), 0)
    page[4] = 0
    page[5] = flags
    let g = granule
    for (let i = 0; i < 8; i++) {
      page[6 + i] = g % 256
      g = Math.floor(g / 256)
    }
    u32le(page, 14, this.serial)
    u32le(page, 18, this.seq++)
    page[26] = lacing.length
    page.set(lacing, 27)
    let pos = 27 + lacing.length
    for (const p of packets) {
      page.set(p, pos)
      pos += p.length
    }
    u32le(page, 22, oggCrc(page))
    this.onPage(page)
  }
}

// ---------- Google Drive (через Apps Script) ----------

// Копит байты и отправляет их в сессию загрузки Drive кусками по 1 МиБ.
// Данные удаляются из буфера только после подтверждения, поэтому повтор безопасен.
export class DriveUploader {
  constructor(post, uploadId) {
    this.post = post
    this.uploadId = uploadId
    this.parts = []
    this.buffered = 0
    this.sent = 0
    this.result = null
  }

  write(bytes) {
    this.parts.push(bytes)
    this.buffered += bytes.length
  }

  async flush(final) {
    while (this.buffered > UPLOAD_PIECE) await this._sendRetry(() => UPLOAD_PIECE, false)
    if (final && !this.result) this.result = await this._sendRetry(() => this.buffered, true)
    return this.result
  }

  async _sendRetry(size, final) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this._send(size(), final)
      } catch (e) {
        if (attempt >= 3 || (e && e.fatal)) throw e
      }
    }
  }

  _peek(n) {
    const take = []
    let got = 0
    for (const p of this.parts) {
      if (got >= n) break
      const need = n - got
      take.push(p.length <= need ? p : p.subarray(0, need))
      got += Math.min(p.length, need)
    }
    return concatBytes(take, got)
  }

  _drop(n) {
    while (n > 0 && this.parts.length) {
      const p = this.parts[0]
      if (p.length <= n) {
        n -= p.length
        this.buffered -= p.length
        this.parts.shift()
      } else {
        this.parts[0] = p.subarray(n)
        this.buffered -= n
        n = 0
      }
    }
  }

  // Ответ принимается, только если это ответ именно на наш запрос (поле action).
  // При потерянном или чужом ответе спрашиваем у Drive, что он на самом деле принял.
  async _send(n, final) {
    const bytes = this._peek(n)
    const total = this.sent + bytes.length
    const req = {
      action: 'chunk',
      uploadId: this.uploadId,
      offset: this.sent,
      final,
      total: final ? total : null,
      data: toBase64(bytes),
    }
    let res = null
    try {
      res = await this.post(req)
    } catch (e) {
      res = null
    }
    if (!res || res.action !== 'chunk') res = await this._verify(total, final)
    if (!res.ok) throw failure(res.error || 'Drive не принял данные', res.error === 'no_session')
    if (final && !res.done) throw failure('Drive не подтвердил сохранение файла')
    if (!final && res.done) throw failure('Drive закрыл файл раньше времени', true)
    this.sent = total
    this._drop(bytes.length)
    return res
  }

  async _verify(total, final) {
    let st = null
    try {
      st = await this.post({ action: 'status', uploadId: this.uploadId })
    } catch (e) {
      st = null
    }
    if (!st || st.action !== 'status') throw failure('нет ответа от Google')
    if (!st.ok || st.done) return st
    if (st.received >= total && !final) return st
    // Drive принял меньше: подрезаем буфер до принятого и повторяем остаток
    if (st.received > this.sent) {
      this._drop(st.received - this.sent)
      this.sent = st.received
    }
    throw failure('кусок не дошёл до Drive')
  }
}

function failure(message, fatal) {
  const e = new Error(message)
  e.fatal = !!fatal
  return e
}

export class OffsetError extends Error {
  constructor(expected) {
    super('offset')
    this.expected = expected
  }
}

function randomHex(len) {
  let s = ''
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 16).toString(16)
  return s
}

// "2026-10-07_14-30-05.opus" -> { name: "2026-10-07_14-30-05.ogg", folder: ["2026", "10", "07"] }
export function driveTarget(watchName) {
  const base = String(watchName).replace(/\.opus$/i, '')
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(base)
  return { name: base + '.ogg', folder: m ? [m[1], m[2], m[3]] : ['без даты'] }
}

export function formatDuration(sec) {
  sec = Math.round(sec || 0)
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const mm = (m < 10 ? '0' : '') + m
  const ss = (s < 10 ? '0' : '') + s
  return h ? h + ':' + mm + ':' + ss : m + ':' + ss
}

// Одна запись с часов: приём кусков по порядку, перекодировка в Ogg, загрузка в Drive.
export class RecordingUpload {
  constructor({ watchName, size, post, note }) {
    this.watchName = watchName
    this.size = size
    this.post = post
    this.note = note || ''
    this.target = driveTarget(watchName)
    this.uploadId = randomHex(16)
    this.received = 0
    this.parser = new ZeppOpusParser()
    this.uploader = new DriveUploader(post, this.uploadId)
    this.writer = new OggOpusWriter(Math.floor(Math.random() * 0xffffffff), (page) =>
      this.uploader.write(page),
    )
  }

  async start() {
    let res = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        res = await this.post({
          action: 'start',
          uploadId: this.uploadId,
          name: this.target.name,
          folder: this.target.folder,
          description: this.note,
        })
      } catch (e) {
        res = null
      }
      // повтор безопасен: тот же uploadId просто получит новую сессию
      if (res && res.action === 'start') break
    }
    if (!res || res.action !== 'start') throw new Error('нет ответа от Google')
    if (!res.ok) throw new Error(res.error || 'Drive не создал файл')
    return res
  }

  async push(offset, bytes) {
    if (offset !== this.received) throw new OffsetError(this.received)
    for (const p of this.parser.push(bytes)) this.writer.add(p)
    this.received += bytes.length
    await this.uploader.flush(false)
  }

  async finish() {
    this.writer.finish()
    const res = await this.uploader.flush(true)
    return {
      fileId: res && res.fileId,
      link: res && res.link,
      // полный путь присылает Apps Script; без него — путь внутри корневой папки
      path: (res && res.path) || this.target.folder.concat([this.target.name]).join('/'),
      durationSec: this.writer.durationSec,
    }
  }
}
