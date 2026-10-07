import { BaseSideService } from '@zeppos/zml/base-side'
import { RecordingUpload, formatDuration } from './core'
import { SCRIPT_URL, TOKEN } from './config'

const sessions = {}

function errorText(e) {
  return (e && (e.message || e.reason)) || String(e)
}

// Сессия загрузки в Drive потеряна: начинать файл заново
function isLostSession(e) {
  return errorText(e).indexOf('no_session') >= 0
}

function parseBody(res) {
  let body = res && res.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch (e) {
      throw new Error('ответ ' + res.status + ': ' + body.slice(0, 120))
    }
  }
  return body
}

async function postScript(payload, timeout = 90000) {
  if (!SCRIPT_URL) throw new Error('не задан SCRIPT_URL в app-side/config.js')
  let res = await fetch({
    url: SCRIPT_URL,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ token: TOKEN }, payload)),
    timeout,
  })
  // Apps Script отвечает редиректом на страницу с результатом
  const status = res && res.status
  const headers = (res && res.headers) || {}
  const location = headers.location || headers.Location
  if (status >= 300 && status < 400 && location) {
    res = await fetch({ url: location, method: 'GET', timeout })
  }
  return parseBody(res)
}

// Проверка перед отправкой: есть ли у телефона интернет и отвечает ли наш скрипт в Google
async function checkGoogle() {
  let res
  try {
    res = await postScript({ action: 'ping' }, 20000)
  } catch (e) {
    const text = errorText(e)
    // сетевой сбой или тайм-аут — скорее всего, нет интернета; кривой ответ — проблема на стороне Google
    if (text.indexOf('ответ ') === 0) return { ok: false, internet: true, error: text }
    return { ok: false, internet: false, error: text }
  }
  if (res && res.action === 'ping' && res.ok) return { ok: true }
  return { ok: false, internet: true, error: (res && res.error) || 'странный ответ' }
}

// Бинарный кусок записи. instanceof ArrayBuffer не годится: буфер может прийти из другого контекста.
function asBytes(req) {
  if (!req || typeof req !== 'object' || typeof req.method === 'string' || req.jsonrpc) return null
  if (typeof req.byteLength !== 'number') return null
  return ArrayBuffer.isView(req) ? new Uint8Array(req.buffer, req.byteOffset, req.byteLength) : new Uint8Array(req)
}

// Заголовок бинарного куска: uint32 LE длина JSON, JSON {name, offset}, затем байты записи
function readChunk(u8) {
  const hlen = u8[0] | (u8[1] << 8) | (u8[2] << 16) | (u8[3] << 24)
  let json = ''
  for (let i = 0; i < hlen; i++) json += String.fromCharCode(u8[4 + i])
  return { header: JSON.parse(json), data: u8.subarray(4 + hlen) }
}

AppSideService(
  BaseSideService({
    onInit() {
      this.log('recorder side service started')
    },

    onRun() {},

    onDestroy() {},

    onRequest(req, res) {
      let task
      const bytes = asBytes(req)
      if (bytes) {
        task = this.onChunk(bytes)
      } else {
        const params = (req && req.params) || {}
        const method = req && req.method
        switch (method) {
          case 'rec.ping':
            task = postScript({ action: 'ping' })
            break
          case 'rec.check':
            task = checkGoogle()
            break
          case 'rec.begin':
            task = this.onBegin(params)
            break
          case 'rec.end':
            task = this.onEnd(params)
            break
          default:
            task = Promise.resolve({
              ok: false,
              error: 'неизвестный запрос ' + (method || typeof req) + (req && req.jsonrpc ? ' (данные не дошли)' : ''),
            })
        }
      }
      task.then(
        (result) => res(null, result),
        (e) => {
          this.error('request failed', errorText(e))
          res(null, { ok: false, error: errorText(e) })
        },
      )
    },

    async onBegin({ name, size, durationSec }) {
      const old = sessions[name]
      if (old && old.size === size) {
        return { ok: true, offset: old.received }
      }
      const upload = new RecordingUpload({
        watchName: name,
        size,
        post: postScript,
        note: 'Amazfit Balance 2 · ' + formatDuration(durationSec) + ' · ' + size + ' байт',
      })
      await upload.start()
      sessions[name] = upload
      return { ok: true, offset: 0 }
    },

    async onChunk(bytes) {
      const { header, data } = readChunk(bytes)
      const upload = sessions[header.name]
      if (!upload) return { ok: false, error: 'no_session' }
      try {
        await upload.push(header.offset, data)
      } catch (e) {
        if (e && typeof e.expected === 'number') {
          return { ok: false, error: 'offset', expected: e.expected }
        }
        if (isLostSession(e)) {
          delete sessions[header.name]
          return { ok: false, error: 'restart' }
        }
        throw e
      }
      return { ok: true, received: upload.received }
    },

    async onEnd({ name }) {
      const upload = sessions[name]
      if (!upload) return { ok: false, error: 'no_session' }
      if (upload.received !== upload.size) {
        return { ok: false, error: 'offset', expected: upload.received }
      }
      let result
      try {
        result = await upload.finish()
      } catch (e) {
        if (isLostSession(e)) {
          delete sessions[name]
          return { ok: false, error: 'restart' }
        }
        throw e
      }
      delete sessions[name]
      return Object.assign({ ok: true }, result)
    },
  }),
)
