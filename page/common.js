// Общее для экранов: время, экран, файлы записей на часах.
import { readdirSync, statSync, rmSync, mkdirSync, readFileSync, writeFileSync } from '@zos/fs'
import {
  setPageBrightTime,
  pauseDropWristScreenOff,
  pausePalmScreenOff,
  resetDropWristScreenOff,
  resetPalmScreenOff,
} from '@zos/display'
import { deleteWidget, prop } from '@zos/ui'
import { Time } from '@zos/sensor'
import * as zosTimer from '@zos/timer'
import { L } from './i18n'

export const REC_DIR = 'rec'

export const COLOR = {
  RED: 0xff3b30,
  GREEN: 0x34c759,
  WHITE: 0xffffff,
  GRAY: 0x8e8e93,
  CLOCK: 0xc7c7cc,
  BUTTON: 0x2c2c2e,
  BUTTON_PRESS: 0x48484a,
  BUTTON_GREEN: 0x1f5c2e,
  BUTTON_GREEN_PRESS: 0x2e7d43,
  BUTTON_RED: 0x5c1f1c,
  BUTTON_RED_PRESS: 0x7d2b27,
}

export const clock = new Time()

export function later(fn, ms) {
  return zosTimer.setTimeout ? zosTimer.setTimeout(fn, ms) : setTimeout(fn, ms)
}

export function cancel(handle) {
  if (!handle) return
  try {
    if (zosTimer.clearTimeout) zosTimer.clearTimeout(handle)
    else clearTimeout(handle)
  } catch (e) {}
}

export function pad(n) {
  return (n < 10 ? '0' : '') + n
}

export function stamp() {
  return (
    clock.getFullYear() + '-' + pad(clock.getMonth()) + '-' + pad(clock.getDate()) + '_' +
    pad(clock.getHours()) + '-' + pad(clock.getMinutes()) + '-' + pad(clock.getSeconds())
  )
}

export function formatElapsed(sec) {
  sec = Math.max(0, Math.round(sec || 0))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s)
}

export function errorText(e) {
  if (!e) return L('ошибка', 'error')
  return e.message || e.reason || String(e)
}

// Пока экран горит, приложение живёт: при погасшем экране Zepp OS закрывает его через 10 с
export function keepScreenOn() {
  try {
    setPageBrightTime({ brightTime: 2147483000 })
  } catch (e) {}
  try {
    pauseDropWristScreenOff({ duration: 0 })
  } catch (e) {}
  try {
    pausePalmScreenOff({ duration: 0 })
  } catch (e) {}
}

export function releaseScreen() {
  try {
    resetDropWristScreenOff()
  } catch (e) {}
  try {
    resetPalmScreenOff()
  } catch (e) {}
}

export function removeWidget(w) {
  if (!w) return
  try {
    deleteWidget(w)
  } catch (e) {
    try {
      w.setProperty(prop.VISIBLE, false)
    } catch (e2) {}
  }
}

// ---------- записи на часах: rec/ГГГГ-ММ-ДД_чч-мм-сс.opus + .json с длительностью ----------

export function ensureDir() {
  try {
    mkdirSync({ path: REC_DIR })
  } catch (e) {}
}

export function recPath(name) {
  return REC_DIR + '/' + name
}

function metaPath(name) {
  return REC_DIR + '/' + name.replace(/\.opus$/, '.json')
}

// Неотправленные записи, старые первыми
export function listPending() {
  const names = readdirSync({ path: REC_DIR }) || []
  return names.filter((n) => /\.opus$/.test(n)).sort()
}

export function fileSize(name) {
  const st = statSync({ path: recPath(name) })
  return st ? st.size : 0
}

export function writeMeta(name, meta) {
  try {
    writeFileSync({ path: metaPath(name), data: JSON.stringify(meta), options: { encoding: 'utf8' } })
  } catch (e) {}
}

export function readMeta(name) {
  try {
    return JSON.parse(readFileSync({ path: metaPath(name), options: { encoding: 'utf8' } })) || {}
  } catch (e) {
    return {}
  }
}

export function removeRecording(name) {
  try {
    rmSync({ path: recPath(name) })
  } catch (e) {}
  try {
    rmSync({ path: metaPath(name) })
  } catch (e) {}
}

// "2026-10-07_22-46-42.opus" -> "07.10 · 22:46"
export function prettyName(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})/.exec(name)
  return m ? m[3] + '.' + m[2] + ' · ' + m[4] + ':' + m[5] : name
}

export function prettySize(bytes) {
  return bytes >= 1048576
    ? (bytes / 1048576).toFixed(1) + L(' МБ', ' MB')
    : Math.max(1, Math.round(bytes / 1024)) + L(' КБ', ' KB')
}
