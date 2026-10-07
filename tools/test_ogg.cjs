// Проверка телефонной части без часов: синтетическая запись в формате Zepp OS →
// RecordingUpload (как в app-side) → «Drive» в памяти со строгими правилами resumable upload →
// разбор получившегося Ogg, сверка пакетов, CRC, длительности и декодирование.
const fs = require('fs')
const path = require('path')
const OpusScript = require('opusscript')

const OUT_DIR = path.join(__dirname, '..', 'test_out')
const SECONDS = Number(process.argv[2] || 75)
const CHUNK = 32 * 1024

function assert(cond, msg) {
  if (!cond) throw new Error('ПРОВАЛ: ' + msg)
}

// --- 1. «Запись часов»: 16 кГц моно, кадры 20 мс, формат opus_demo ---
function makeZeppRecording(seconds) {
  const enc = new OpusScript(16000, 1, OpusScript.Application.VOIP)
  const frame = 320
  const packets = []
  const parts = []
  for (let f = 0; f < (seconds * 1000) / 20; f++) {
    const pcm = Buffer.alloc(frame * 2)
    const t0 = f * frame
    const silent = Math.floor(f / 150) % 4 === 3 // каждые 3 с из 12 — тишина
    for (let i = 0; i < frame; i++) {
      const t = (t0 + i) / 16000
      const v = silent ? 0 : Math.sin(2 * Math.PI * (220 + 30 * Math.sin(t)) * t) * 9000
      pcm.writeInt16LE(Math.round(v), i * 2)
    }
    const pkt = Buffer.from(enc.encode(pcm, frame))
    packets.push(pkt)
    const head = Buffer.alloc(8)
    head.writeUInt32BE(pkt.length, 0)
    head.writeUInt32BE((Math.random() * 0xffffffff) >>> 0, 4)
    parts.push(head, pkt)
  }
  enc.delete()
  return { file: Buffer.concat(parts), packets }
}

// --- 2. «Apps Script + Drive»: проверяет выравнивание 256 КиБ, смещения, финал ---
// faults: { номер_обращения: 'drop-after' | 'wrong-after' | 'wrong-before' }
//   drop-after   — запрос выполнен, ответ потерян (исключение);
//   wrong-after  — запрос выполнен, но вернулась чужая страница (ответ doGet);
//   wrong-before — запрос не выполнен, вернулась чужая страница.
function makeFakeDrive(faults = {}) {
  const sessions = {}
  const files = {}
  let calls = 0
  const used = []
  const DOGET = { ok: true, service: 'amazfit-recorder' }

  function handle(req) {
    if (req.action === 'start') {
      assert(req.name && req.folder, 'start без имени/папки')
      sessions[req.uploadId] = { parts: [], received: 0, name: req.name, folder: req.folder, done: false }
      return { ok: true }
    }
    const s = sessions[req.uploadId]
    if (!s) return { ok: false, error: 'no_session' }
    if (req.action === 'status' || (req.action === 'chunk' && s.done)) {
      return s.done
        ? { ok: true, done: true, fileId: s.fileId, link: 'https://drive/' + s.fileId }
        : { ok: true, done: false, received: s.received }
    }
    assert(req.action === 'chunk', 'неизвестное действие ' + req.action)
    const bytes = Buffer.from(req.data, 'base64')
    assert(req.offset === s.received, `смещение ${req.offset} ≠ принято ${s.received}`)
    if (!req.final) assert(bytes.length % (256 * 1024) === 0, 'промежуточный кусок не кратен 256 КиБ: ' + bytes.length)
    s.parts.push(bytes)
    s.received += bytes.length
    if (!req.final) return { ok: true, done: false, received: s.received }
    assert(req.total === s.received, 'total не совпал')
    s.done = true
    s.fileId = 'file' + Object.keys(files).length
    files[s.fileId] = { name: s.name, folder: s.folder, data: Buffer.concat(s.parts) }
    return { ok: true, done: true, fileId: s.fileId, link: 'https://drive/' + s.fileId }
  }

  async function post(req) {
    calls++
    const fault = faults[calls]
    if (fault) used.push(calls + ':' + fault + ':' + req.action + (req.final ? '(final)' : ''))
    if (fault === 'wrong-before') return DOGET
    const res = Object.assign(handle(req), { action: req.action })
    if (fault === 'drop-after') throw new Error('имитация: ответ потерян')
    if (fault === 'wrong-after') return DOGET
    return res
  }
  return { post, files, used, calls: () => calls }
}

// --- 3. Разбор Ogg независимым кодом ---
function crcTable() {
  const t = []
  for (let i = 0; i < 256; i++) {
    let r = i << 24
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1
    t.push(r >>> 0)
  }
  return t
}
const TABLE = crcTable()
function crc(buf) {
  let c = 0
  for (const b of buf) c = ((c << 8) ^ TABLE[((c >>> 24) ^ b) & 255]) >>> 0
  return c
}

function parseOgg(data) {
  const packets = []
  const pages = []
  let pos = 0
  let partial = []
  while (pos < data.length) {
    assert(data.toString('ascii', pos, pos + 4) === 'OggS', 'нет OggS на ' + pos)
    const flags = data[pos + 5]
    const granule = Number(data.readBigUInt64LE(pos + 6))
    const serial = data.readUInt32LE(pos + 14)
    const seq = data.readUInt32LE(pos + 18)
    const storedCrc = data.readUInt32LE(pos + 22)
    const nseg = data[pos + 26]
    const lacing = data.subarray(pos + 27, pos + 27 + nseg)
    const bodyLen = lacing.reduce((a, b) => a + b, 0)
    const pageLen = 27 + nseg + bodyLen
    const page = Buffer.from(data.subarray(pos, pos + pageLen))
    page.writeUInt32LE(0, 22)
    assert(crc(page) === storedCrc, 'CRC страницы ' + seq)
    pages.push({ flags, granule, serial, seq })
    let bpos = pos + 27 + nseg
    for (const l of lacing) {
      partial.push(data.subarray(bpos, bpos + l))
      bpos += l
      if (l < 255) {
        packets.push(Buffer.concat(partial))
        partial = []
      }
    }
    pos += pageLen
  }
  assert(partial.length === 0, 'незавершённый пакет в конце')
  return { pages, packets }
}

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const core = await import('../app-side/core.js')
  const { file, packets } = makeZeppRecording(SECONDS)
  console.log(`запись: ${SECONDS} с, ${packets.length} пакетов, ${file.length} байт (${Math.round((file.length * 8) / SECONDS / 1000)} кбит/с)`)

  // Сбои связи с «Apps Script»: формат аргумента "2:wrong-before,4:drop-after"
  const faults = {}
  String(process.argv[3] || '').split(',').filter(Boolean).forEach((f) => {
    const [n, kind] = f.split(':')
    faults[Number(n)] = kind
  })
  const drive = makeFakeDrive(faults)
  const watchName = '2026-10-07_14-30-05.opus'
  const up = new core.RecordingUpload({ watchName, size: file.length, post: drive.post, note: 'test' })
  await up.start()

  // Куски по 32 КБ, как с часов; один раз шлём неверное смещение
  let offset = 0
  let mismatchTested = false
  while (offset < file.length) {
    const len = Math.min(CHUNK, file.length - offset)
    if (!mismatchTested && offset > 0) {
      mismatchTested = true
      try {
        await up.push(offset - 100, file.subarray(offset - 100, offset - 100 + len))
        assert(false, 'неверное смещение принято')
      } catch (e) {
        assert(e.expected === offset, 'OffsetError не вернул ожидаемое смещение')
      }
    }
    await up.push(offset, new Uint8Array(file.subarray(offset, offset + len)))
    offset += len
  }
  const result = await up.finish()
  console.log('итог:', result.path, 'fileId=' + result.fileId, 'длительность', result.durationSec.toFixed(2), 'с')

  const saved = drive.files[result.fileId]
  assert(saved && saved.name === '2026-10-07_14-30-05.ogg', 'имя файла в Drive')
  assert(saved.folder.join('/') === '2026/10/07', 'папка в Drive')
  const ogg = saved.data
  fs.writeFileSync(path.join(OUT_DIR, 'test.ogg'), ogg)

  const { pages, packets: got } = parseOgg(ogg)
  assert(pages[0].flags === 0x02, 'первая страница без BOS')
  assert(pages[pages.length - 1].flags & 0x04, 'последняя страница без EOS')
  pages.forEach((p, i) => assert(p.seq === i && p.serial === pages[0].serial, 'нумерация страниц'))
  for (let i = 1; i < pages.length; i++) assert(pages[i].granule >= pages[i - 1].granule, 'granule убывает')
  assert(got[0].toString('ascii', 0, 8) === 'OpusHead', 'OpusHead')
  assert(got[0].readUInt16LE(10) === 312 && got[0].readUInt32LE(12) === 16000, 'поля OpusHead')
  assert(got[1].toString('ascii', 0, 8) === 'OpusTags', 'OpusTags')
  const audio = got.slice(2)
  assert(audio.length === packets.length, `пакетов ${audio.length} ≠ ${packets.length}`)
  audio.forEach((p, i) => assert(p.equals(packets[i]), 'пакет ' + i + ' искажён'))
  const lastGranule = pages[pages.length - 1].granule
  assert(lastGranule === packets.length * 960, 'granule в конце: ' + lastGranule)

  const dec = new OpusScript(48000, 1)
  let samples = 0
  for (const p of audio) samples += dec.decode(p).length / 2
  dec.delete()
  assert(samples === packets.length * 960, 'декодировано ' + samples)

  // Страница для проверки в браузере (данные внутри, чтобы работало с file://)
  const html = `<!doctype html><meta charset="utf-8"><title>ogg check</title>
<audio id="a" controls src="data:audio/ogg;base64,${ogg.toString('base64')}"></audio>
<pre id="out">проверяю…</pre>
<script>
const out = document.getElementById('out')
const a = document.getElementById('a')
a.addEventListener('loadedmetadata', () => { window.audioDuration = a.duration; report() })
fetch(a.src).then(r => r.arrayBuffer()).then(b => new AudioContext().decodeAudioData(b))
  .then(buf => { window.decoded = { duration: buf.duration, rate: buf.sampleRate, length: buf.length }; report() })
  .catch(e => { window.decoded = { error: String(e) }; report() })
function report() { out.textContent = JSON.stringify({ audioDuration: window.audioDuration, decoded: window.decoded }, null, 1) }
</script>`
  fs.writeFileSync(path.join(OUT_DIR, 'play.html'), html)

  console.log(`OK: ${pages.length} страниц Ogg, ${audio.length} пакетов совпали байт в байт, CRC верны, `
    + `декодировано ${(samples / 48000).toFixed(2)} с, выгрузка ${ogg.length} байт, `
    + `обращений ${drive.calls()}, сбоев отработано: ${drive.used.join(' ') || 'нет'}`)
  assert(drive.used.length === Object.keys(faults).length, 'не все заданные сбои сработали')
  console.log('файлы:', path.join(OUT_DIR, 'test.ogg'), path.join(OUT_DIR, 'play.html'))
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
