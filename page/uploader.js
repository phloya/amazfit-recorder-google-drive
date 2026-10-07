// Отправка записей: часы → телефон (Bluetooth) → Google Drive.
// Запись удаляется с часов только после того, как Drive подтвердил сохранение.
import { openSync, readSync, closeSync, O_RDONLY } from '@zos/fs'
import { clock, later, cancel, recPath, readMeta, removeRecording, fileSize, errorText } from './common'
import { L } from './i18n'

const CHUNK_SIZE = 32 * 1024 // байт за один запрос к телефону

// Понятная причина, если до телефона не достучались
export function connectionProblem(e) {
  if (!e) return L('Нет связи с телефоном', 'No connection to the phone')
  if (e.code === 2) return L('Нет связи с телефоном (Bluetooth)', 'No connection to the phone (Bluetooth)')
  if (e.code === 1 || e.code === 3) return L('Приложение Zepp на телефоне не отвечает', 'Zepp app on the phone is not responding')
  if (e.code === 4) return L('Телефон не ответил', 'The phone did not respond')
  return errorText(e)
}

export class Uploader {
  constructor(page) {
    this.page = page
    this.timers = []
  }

  request(data, opts) {
    return this.page.request(data, opts)
  }

  dispose() {
    this.timers.forEach(cancel)
    this.timers = []
  }

  wait(ms) {
    return new Promise((resolve) => this.timers.push(later(resolve, ms)))
  }

  // Быстрая проверка перед отправкой. Пустая строка — связь есть, иначе текст проблемы.
  check() {
    return this.request({ method: 'rec.check', params: {} }, { timeout: 30000 }).then(
      (r) => {
        if (r && r.ok) return ''
        if (r && r.internet === false) return L('На телефоне нет интернета', 'No internet on the phone')
        return L('Google недоступен', 'Google is unreachable') + (r && r.error ? ': ' + r.error : '')
      },
      (e) => connectionProblem(e),
    )
  }

  // Отправить все записи по очереди. onProgress({ index, total, name, percent, speed, stage })
  uploadAll(names, onProgress) {
    let index = 0
    const next = () => {
      if (index >= names.length) return Promise.resolve(names.length)
      const name = names[index]
      return this.uploadWithRetry(name, (p) => onProgress(Object.assign({ index, total: names.length, name }, p))).then(
        () => {
          index++
          return next()
        },
      )
    }
    return next()
  }

  uploadWithRetry(name, onProgress) {
    let attempt = 0
    const run = () =>
      this.uploadOne(name, onProgress).catch((e) => {
        attempt++
        if (attempt >= 2 || (e && typeof e.code === 'number')) throw e // нет связи — не мучаем
        return this.wait(2000).then(run)
      })
    return run()
  }

  uploadOne(name, onProgress) {
    const size = fileSize(name)
    if (!size) {
      removeRecording(name)
      return Promise.resolve()
    }
    const durationSec = readMeta(name).durationSec || 0
    onProgress({ percent: 0, stage: L('создаю файл в Google Drive', 'creating the file in Google Drive') })
    return this.request({ method: 'rec.begin', params: { name, size, durationSec } }, { timeout: 90000 })
      .then((r) => {
        if (!r || !r.ok) throw new Error('Drive: ' + ((r && r.error) || L('файл не создан', 'file not created')))
        return this.sendChunks(name, size, r.offset || 0, onProgress)
      })
      .then(() => {
        onProgress({ percent: 100, stage: L('сохраняю в Google Drive', 'saving to Google Drive') })
        return this.request({ method: 'rec.end', params: { name, size } }, { timeout: 120000 })
      })
      .then((r) => {
        if (!r || !r.ok) throw new Error('Drive: ' + ((r && r.error) || L('файл не сохранён', 'file not saved')))
        removeRecording(name)
        this.lastPath = r.path
        return r
      })
  }

  sendChunks(name, size, offset, onProgress) {
    const fd = openSync({ path: recPath(name), flag: O_RDONLY })
    const t0 = clock.getTime()
    const offset0 = offset
    let failures = 0
    return new Promise((resolve, reject) => {
      const done = (err) => {
        try {
          closeSync({ fd })
        } catch (e) {}
        if (err) reject(err)
        else resolve()
      }
      const step = () => {
        if (offset >= size) {
          done()
          return
        }
        const len = Math.min(CHUNK_SIZE, size - offset)
        const header = JSON.stringify({ name, offset })
        const hlen = header.length
        const buf = new ArrayBuffer(4 + hlen + len)
        const u8 = new Uint8Array(buf)
        u8[0] = hlen & 255
        u8[1] = (hlen >> 8) & 255
        u8[2] = (hlen >> 16) & 255
        u8[3] = (hlen >> 24) & 255
        for (let i = 0; i < hlen; i++) u8[4 + i] = header.charCodeAt(i)
        const got = readSync({ fd, buffer: buf, options: { offset: 4 + hlen, length: len, position: offset } })
        if (got !== len) {
          done(new Error(L('не удалось прочитать запись', 'could not read the recording')))
          return
        }
        // Именно Buffer: обычный ArrayBuffer ZML принимает за объект и шлёт как пустой JSON
        this.request(Buffer.from(buf), { contentType: 'bin', dataType: 'json', timeout: 60000 })
          .then((r) => {
            if (r && r.ok) {
              offset += len
              failures = 0
            } else if (r && r.error === 'offset' && typeof r.expected === 'number') {
              offset = r.expected
            } else if (r && (r.error === 'restart' || r.error === 'no_session')) {
              throw new Error(L('связь с Drive прервалась', 'connection to Drive dropped'))
            } else {
              throw new Error(L('Телефон: ', 'Phone: ') + ((r && r.error) || L('не принял данные', 'did not accept data')))
            }
            const secs = Math.max(1, (clock.getTime() - t0) / 1000)
            onProgress({
              percent: Math.floor((offset * 100) / size),
              speed: Math.round((offset - offset0) / 1024 / secs),
              stage: L('отправка', 'sending'),
            })
            step()
          })
          .catch((e) => {
            failures++
            if ((e && typeof e.code === 'number') || failures > 3) done(e)
            else this.timers.push(later(step, 1500))
          })
      }
      step()
    })
  }
}
