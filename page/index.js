// Главный экран: запись сразу при запуске, остановка тройным нажатием, затем отправка.
// Если отправить нельзя (нет телефона или интернета), запись остаётся на часах.
import { BasePage } from '@zeppos/zml/base-page'
import { create, id, codec } from '@zos/media'
import { createWidget, widget, prop, align, text_style, event } from '@zos/ui'
import {
  onKey,
  offKey,
  KEY_EVENT_CLICK,
  KEY_EVENT_DOUBLE_CLICK,
  KEY_EVENT_LONG_PRESS,
  KEY_EVENT_RELEASE,
} from '@zos/interaction'
import { exit, replace } from '@zos/router'
import { getDeviceInfo } from '@zos/device'
import {
  COLOR,
  clock,
  later,
  cancel,
  pad,
  stamp,
  formatElapsed,
  errorText,
  keepScreenOn,
  releaseScreen,
  removeWidget,
  ensureDir,
  listPending,
  fileSize,
  writeMeta,
  removeRecording,
} from './common'
import { Uploader } from './uploader'
import { L, pressesLeft } from './i18n'

const MIN_SECONDS = 3 // записи короче (случайное нажатие) не сохраняем — так же можно просто дослать старые
const STOP_PRESSES = 3 // запись останавливается тройным нажатием кнопки, одиночное ничего не делает
const PRESS_WINDOW_MS = 1500 // все нажатия должны уложиться в это время
const HOLD_TO_STOP_MS = 1500 // запасной способ: удержать палец на экране
const RECORD_HINT = L('кнопка 3 раза — стоп', 'press 3 times to stop')

Page(
  BasePage({
    state: {},

    build() {
      const { width, height } = getDeviceInfo()
      this.width = width
      this.height = height
      this.mode = 'starting'
      this.timers = {}
      this.buttons = []
      this.uploader = new Uploader(this)

      const bg = createWidget(widget.FILL_RECT, { x: 0, y: 0, w: width, h: height, color: 0x000000 })
      // Текущее время вверху — тихо, без подписей
      this.clockText = createWidget(widget.TEXT, {
        x: 0,
        y: Math.round(height * 0.08),
        w: width,
        h: Math.round(height * 0.09),
        text: '',
        text_size: 34,
        color: COLOR.CLOCK,
        align_h: align.CENTER_H,
        align_v: align.CENTER_V,
      })
      this.updateClock()
      this.dot = createWidget(widget.CIRCLE, {
        center_x: Math.round(width / 2),
        center_y: Math.round(height * 0.24),
        radius: 16,
        color: COLOR.RED,
      })
      const line = (y, h, size, color) =>
        createWidget(widget.TEXT, {
          x: 40,
          y: Math.round(height * y),
          w: width - 80,
          h: Math.round(height * h),
          text: '',
          text_size: size,
          color,
          align_h: align.CENTER_H,
          align_v: align.CENTER_V,
          text_style: text_style.WRAP,
        })
      this.title = line(0.3, 0.1, 30, COLOR.GRAY)
      this.big = line(0.4, 0.18, 76, COLOR.WHITE)
      this.info = line(0.58, 0.12, 26, COLOR.GRAY)
      this.hint = line(0.72, 0.1, 24, COLOR.GRAY)
      this.foot = line(0.87, 0.07, 22, COLOR.GRAY)

      bg.addEventListener(event.CLICK_DOWN, () => {
        this.touchAt = clock.getTime()
      })
      bg.addEventListener(event.CLICK_UP, () => this.onTouchUp())

      keepScreenOn()
      onKey({ callback: (key, keyEvent) => this.onKeyEvent(keyEvent) })

      this.startRecording()
    },

    onDestroy() {
      if (this.mode === 'recording' && this.recorder) {
        try {
          this.recorder.stop()
        } catch (e) {}
        this.saveMeta()
      }
      Object.keys(this.timers).forEach((k) => cancel(this.timers[k]))
      this.uploader.dispose()
      try {
        offKey()
      } catch (e) {}
      releaseScreen()
    },

    show(title, big, info, hint, color) {
      this.title.setProperty(prop.MORE, { text: title || '' })
      this.big.setProperty(prop.MORE, { text: big || '', color: color || COLOR.WHITE })
      this.info.setProperty(prop.MORE, { text: info || '' })
      this.hint.setProperty(prop.MORE, { text: hint || '' })
    },

    setDot(visible) {
      this.dot.setProperty(prop.VISIBLE, !!visible)
    },

    // Часы:минуты; следующее обновление — ровно на смене минуты
    updateClock() {
      this.clockText.setProperty(prop.MORE, { text: pad(clock.getHours()) + ':' + pad(clock.getMinutes()) })
      this.timers.clock = later(() => this.updateClock(), (60 - clock.getSeconds()) * 1000 + 50)
    },

    clearButtons() {
      this.buttons.forEach(removeWidget)
      this.buttons = []
    },

    // Кнопки на экране: [{ text, onClick, green? }] — по две в ряд внизу
    showButtons(list) {
      this.clearButtons()
      const w = 170
      const h = 64
      const gap = 16
      const y = Math.round(this.height * 0.72)
      const total = list.length * w + (list.length - 1) * gap
      let x = Math.round((this.width - total) / 2)
      list.forEach((b) => {
        this.buttons.push(
          createWidget(widget.BUTTON, {
            x,
            y,
            w,
            h,
            radius: 32,
            text: b.text,
            text_size: 26,
            color: COLOR.WHITE,
            normal_color: b.green ? COLOR.BUTTON_GREEN : COLOR.BUTTON,
            press_color: b.green ? COLOR.BUTTON_GREEN_PRESS : COLOR.BUTTON_PRESS,
            click_func: () => b.onClick(),
          }),
        )
        x += w + gap
      })
    },

    // ---------- запись ----------

    startRecording() {
      ensureDir()
      this.pendingBefore = listPending().length
      this.fileName = stamp() + '.opus'
      try {
        this.recorder = create(id.RECORDER)
      } catch (e) {
        this.fatal(L('Микрофон недоступен', 'Microphone unavailable'), errorText(e))
        return
      }
      try {
        this.recorder.addEventListener(this.recorder.event.START, (ok) => {
          if (ok === false) this.fatal(L('Микрофон не включился', 'Microphone did not start'))
        })
        // запись прервалась сама (например, звонок) — сохраняем и отправляем то, что есть
        this.recorder.addEventListener(this.recorder.event.STOP, () => {
          if (this.mode === 'recording' || this.mode === 'stopping') this.afterStop()
        })
      } catch (e) {}
      try {
        this.recorder.setFormat(codec.OPUS, { target_file: 'data://rec/' + this.fileName })
        this.recorder.start()
      } catch (e) {
        this.fatal(L('Микрофон не включился', 'Microphone did not start'), errorText(e))
        return
      }
      this.startedAt = clock.getTime()
      this.mode = 'recording'
      this.tick()
    },

    tick() {
      if (this.mode !== 'recording') return
      const sec = Math.floor((clock.getTime() - this.startedAt) / 1000)
      this.show(
        L('ЗАПИСЬ', 'RECORDING'),
        formatElapsed(sec),
        this.pendingBefore ? L('не отправлено: ', 'not sent: ') + this.pendingBefore : '',
        this.pressHint || RECORD_HINT,
        COLOR.WHITE,
      )
      this.setDot(sec % 2 === 0)
      this.timers.tick = later(() => this.tick(), 1000)
    },

    saveMeta() {
      this.durationSec = Math.round((clock.getTime() - this.startedAt) / 1000)
      writeMeta(this.fileName, { durationSec: this.durationSec })
    },

    stopRecording() {
      if (this.mode !== 'recording') return
      this.mode = 'stopping'
      this.ignoreKeysUntil = clock.getTime() + 2000
      this.show(L('Сохраняю...', 'Saving...'), '', '', '')
      try {
        this.recorder.stop()
      } catch (e) {}
      // событие STOP приходит не на всех прошивках — подстрахуемся таймером
      this.timers.stop = later(() => this.afterStop(), 700)
    },

    afterStop() {
      if (this.stopped) return
      this.stopped = true
      cancel(this.timers.tick)
      this.setDot(false)
      this.saveMeta()
      if (!fileSize(this.fileName) || this.durationSec < MIN_SECONDS) removeRecording(this.fileName)
      this.sendAll()
    },

    // ---------- отправка ----------

    sendAll() {
      this.clearButtons()
      this.foot.setProperty(prop.MORE, { text: '' })
      cancel(this.timers.exit)
      const files = listPending()
      if (!files.length) {
        this.finish(
          L('Нечего отправлять', 'Nothing to send'),
          L('запись короче ' + MIN_SECONDS + ' с не сохраняется', 'recordings under ' + MIN_SECONDS + ' s are not kept'),
        )
        return
      }
      this.mode = 'checking'
      this.show(
        L('Проверяю связь', 'Checking connection'),
        '...',
        L('часы → телефон → интернет', 'watch → phone → internet'),
        L('кнопка — выйти', 'button — exit'),
      )
      this.uploader.check().then((problem) => {
        if (this.mode !== 'checking') return
        if (problem) {
          this.offline(problem)
          return
        }
        this.mode = 'uploading'
        this.uploader
          .uploadAll(files, (p) => {
            const n = p.index + 1
            const label =
              p.total > 1 ? L('Отправка ' + n + ' из ' + p.total, 'Sending ' + n + ' of ' + p.total) : L('Отправка', 'Sending')
            const info = p.speed ? p.speed + L(' КБ/с', ' KB/s') : p.stage
            this.show(label, p.percent + '%', info, L('кнопка — выйти, отправлю позже', 'button — exit, send later'))
          })
          .then(
            () => this.finish(L('Отправлено', 'Sent'), this.uploader.lastPath || 'Google Drive'),
            (e) =>
              this.offline(
                e && typeof e.code === 'number' ? L('Связь с телефоном пропала', 'Lost connection to the phone') : errorText(e),
              ),
          )
      })
    },

    // Отправить не получилось: запись остаётся на часах
    offline(problem) {
      this.mode = 'failed'
      const left = listPending().length
      this.show(L('Не отправлено', 'Not sent'), '!', problem, '', COLOR.RED)
      this.info.setProperty(prop.MORE, { text: problem + L('\nСохранено на часах: ', '\nSaved on the watch: ') + left })
      this.showButtons([
        { text: L('Повторить', 'Retry'), green: true, onClick: () => this.sendAll() },
        { text: L('Записи', 'Records'), onClick: () => this.openFiles() },
      ])
      this.foot.setProperty(prop.MORE, { text: L('кнопка — позже', 'button — later') })
      this.timers.exit = later(() => exit(), 30000)
    },

    openFiles() {
      cancel(this.timers.exit)
      try {
        offKey()
      } catch (e) {}
      replace({ url: 'page/files' })
    },

    finish(title, info) {
      this.mode = 'done'
      this.clearButtons()
      this.foot.setProperty(prop.MORE, { text: '' })
      this.show(title, 'OK', info, L('кнопка — выход', 'button — exit'), COLOR.GREEN)
      this.timers.exit = later(() => exit(), 4000)
    },

    fatal(title, info) {
      this.mode = 'error'
      this.show(title, '!', info || '', '', COLOR.RED)
      this.timers.exit = later(() => exit(), 6000)
    },

    // ---------- управление ----------

    // Во время записи считаем отпускания кнопки: одно физическое нажатие = одно отпускание.
    // Если прошивка не шлёт RELEASE, считаем CLICK (1) и DOUBLE_CLICK (2).
    countPress(keyEvent) {
      const now = clock.getTime()
      let n = 0
      if (keyEvent === KEY_EVENT_RELEASE) {
        n = 1
        this.lastReleaseAt = now
      } else if (keyEvent === KEY_EVENT_CLICK || keyEvent === KEY_EVENT_DOUBLE_CLICK) {
        if (now - (this.lastReleaseAt || 0) > 400) n = keyEvent === KEY_EVENT_DOUBLE_CLICK ? 2 : 1
      }
      if (!n) return
      if (!this.pressStart || now - this.pressStart > PRESS_WINDOW_MS) {
        this.pressStart = now
        this.pressCount = 0
      }
      this.pressCount += n
      cancel(this.timers.pressHint)
      if (this.pressCount >= STOP_PRESSES) {
        this.pressCount = 0
        this.pressHint = ''
        this.stopRecording()
        return
      }
      this.pressHint = pressesLeft(STOP_PRESSES - this.pressCount)
      this.hint.setProperty(prop.MORE, { text: this.pressHint })
      this.timers.pressHint = later(() => {
        this.pressHint = ''
        if (this.mode === 'recording') this.hint.setProperty(prop.MORE, { text: RECORD_HINT })
      }, PRESS_WINDOW_MS)
    },

    onKeyEvent(keyEvent) {
      if (this.mode === 'recording') {
        this.countPress(keyEvent)
        return true
      }
      // хвосты тройного нажатия (запоздалые CLICK) не должны прерывать начавшуюся отправку
      if (clock.getTime() < (this.ignoreKeysUntil || 0)) return true
      if (keyEvent !== KEY_EVENT_CLICK && keyEvent !== KEY_EVENT_LONG_PRESS) return true
      // в остальных состояниях кнопка — «выйти»; неотправленное остаётся на часах
      if (this.mode !== 'stopping') exit()
      return true
    },

    onTouchUp() {
      const held = clock.getTime() - (this.touchAt || 0)
      if (this.mode === 'recording' && held >= HOLD_TO_STOP_MS) this.stopRecording()
      else if (this.mode === 'done') exit()
    },
  }),
)
