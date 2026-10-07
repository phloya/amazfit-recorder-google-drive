// Проверка настоящего Apps Script с компьютера, без часов:
// node tools/test_drive.js [URL]  — ping, затем выгрузка синтетической записи в Диктофон/ГГГГ/ММ/
const fs = require('fs')
const path = require('path')
const OpusScript = require('opusscript')

async function main() {
  const cfgText = fs.readFileSync(path.join(__dirname, '..', 'app-side', 'config.js'), 'utf8')
  const url = process.argv[2] || (/SCRIPT_URL\s*=\s*'([^']*)'/.exec(cfgText) || [])[1]
  const token = (/TOKEN\s*=\s*'([^']*)'/.exec(cfgText) || [])[1]
  if (!url) throw new Error('нет URL: передайте его аргументом или впишите в app-side/config.js')

  const post = async (payload) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ token }, payload)),
      redirect: 'follow',
    })
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch (e) {
      throw new Error('ответ ' + res.status + ': ' + text.slice(0, 200))
    }
  }

  console.log('ping:', JSON.stringify(await post({ action: 'ping' })))

  // 20 секунд тона, упакованные как запись с часов
  const enc = new OpusScript(16000, 1, OpusScript.Application.VOIP)
  const parts = []
  for (let f = 0; f < 1000; f++) {
    const pcm = Buffer.alloc(640)
    for (let i = 0; i < 320; i++) {
      pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * (f * 320 + i)) / 16000) * 6000), i * 2)
    }
    const pkt = Buffer.from(enc.encode(pcm, 320))
    const head = Buffer.alloc(8)
    head.writeUInt32BE(pkt.length, 0)
    parts.push(head, pkt)
  }
  enc.delete()
  const file = Buffer.concat(parts)

  const core = await import('../app-side/core.js')
  const d = new Date()
  const p2 = (n) => String(n).padStart(2, '0')
  const name = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}_test.opus`
  const up = new core.RecordingUpload({ watchName: name, size: file.length, post, note: 'тест с компьютера' })
  await up.start()
  for (let off = 0; off < file.length; off += 32768) {
    await up.push(off, new Uint8Array(file.subarray(off, off + 32768)))
  }
  const result = await up.finish()
  console.log('загружено:', JSON.stringify(result))
}

main().catch((e) => {
  console.error('ОШИБКА:', e.message)
  process.exit(1)
})
