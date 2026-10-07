// Экран «Записи»: неотправленные записи на часах. Нажал на запись → «Отправить» или «Удалить».
import { BasePage } from '@zeppos/zml/base-page'
import { createWidget, widget, prop, align, text_style } from '@zos/ui'
import { onKey, offKey, KEY_EVENT_CLICK, KEY_EVENT_LONG_PRESS } from '@zos/interaction'
import { exit } from '@zos/router'
import { getDeviceInfo } from '@zos/device'
import {
  COLOR,
  later,
  cancel,
  formatElapsed,
  errorText,
  keepScreenOn,
  releaseScreen,
  removeWidget,
  ensureDir,
  listPending,
  fileSize,
  readMeta,
  removeRecording,
  prettyName,
  prettySize,
} from './common'
import { Uploader } from './uploader'
import { L } from './i18n'

const ROWS = 3 // столько записей помещается на круглом экране

Page(
  BasePage({
    state: {},

    build() {
      const { width, height } = getDeviceInfo()
      this.width = width
      this.height = height
      this.widgets = []
      this.timers = {}
      this.uploader = new Uploader(this)
      createWidget(widget.FILL_RECT, { x: 0, y: 0, w: width, h: height, color: 0x000000 })
      keepScreenOn()
      ensureDir()
      onKey({ callback: (key, keyEvent) => this.onKeyEvent(keyEvent) })
      this.showList()
    },

    onDestroy() {
      Object.keys(this.timers).forEach((k) => cancel(this.timers[k]))
      this.uploader.dispose()
      try {
        offKey()
      } catch (e) {}
      releaseScreen()
    },

    // ---------- элементы ----------

    clear() {
      this.widgets.forEach(removeWidget)
      this.widgets = []
      cancel(this.timers.exit)
    },

    text(y, h, size, color, value) {
      const w = createWidget(widget.TEXT, {
        x: 40,
        y,
        w: this.width - 80,
        h,
        text: value,
        text_size: size,
        color,
        align_h: align.CENTER_H,
        align_v: align.CENTER_V,
        text_style: text_style.WRAP,
      })
      this.widgets.push(w)
      return w
    },

    button(y, value, onClick, kind) {
      const w = 300
      const colors = {
        green: [COLOR.BUTTON_GREEN, COLOR.BUTTON_GREEN_PRESS],
        red: [COLOR.BUTTON_RED, COLOR.BUTTON_RED_PRESS],
      }[kind] || [COLOR.BUTTON, COLOR.BUTTON_PRESS]
      this.widgets.push(
        createWidget(widget.BUTTON, {
          x: Math.round((this.width - w) / 2),
          y,
          w,
          h: 62,
          radius: 31,
          text: value,
          text_size: 28,
          color: COLOR.WHITE,
          normal_color: colors[0],
          press_color: colors[1],
          click_func: () => onClick(),
        }),
      )
    },

    // ---------- экраны ----------

    showList() {
      this.clear()
      this.view = 'list'
      const files = listPending().reverse() // новые сверху
      if (!files.length) {
        this.text(150, 60, 34, COLOR.GREEN, L('Всё отправлено', 'All sent'))
        this.text(220, 80, 26, COLOR.GRAY, L('На часах нет неотправленных записей', 'No unsent recordings on the watch'))
        this.text(360, 40, 24, COLOR.GRAY, L('кнопка — выход', 'button — exit'))
        this.timers.exit = later(() => exit(), 5000)
        return
      }
      this.text(50, 50, 30, COLOR.WHITE, L('Не отправлено: ', 'Not sent: ') + files.length)
      this.button(110, L('Отправить все', 'Send all'), () => this.send(listPending()), 'green')
      files.slice(0, ROWS).forEach((name, i) => {
        const dur = readMeta(name).durationSec
        const label = prettyName(name) + (dur ? ' · ' + formatElapsed(dur) : '')
        this.button(190 + i * 72, label, () => this.showDetail(name))
      })
      if (files.length > ROWS) this.text(400, 34, 22, COLOR.GRAY, L('и ещё ', 'and ') + (files.length - ROWS) + L('', ' more'))
      else this.text(410, 34, 22, COLOR.GRAY, L('кнопка — выход', 'button — exit'))
    },

    showDetail(name) {
      this.clear()
      this.view = 'detail'
      const dur = readMeta(name).durationSec
      this.text(90, 56, 36, COLOR.WHITE, prettyName(name))
      this.text(150, 44, 26, COLOR.GRAY, (dur ? formatElapsed(dur) + ' · ' : '') + prettySize(fileSize(name)))
      this.button(220, L('Отправить', 'Send'), () => this.send([name]), 'green')
      this.button(300, L('Удалить', 'Delete'), () => this.confirmDelete(name), 'red')
      this.text(390, 34, 22, COLOR.GRAY, L('кнопка — назад', 'button — back'))
    },

    confirmDelete(name) {
      this.clear()
      this.view = 'confirm'
      this.text(110, 56, 34, COLOR.WHITE, L('Удалить запись?', 'Delete recording?'))
      this.text(165, 50, 24, COLOR.GRAY, prettyName(name) + L('\nв Google Drive она не попадёт', '\nit will not reach Google Drive'))
      this.button(240, L('Удалить', 'Delete'), () => {
        removeRecording(name)
        this.showList()
      }, 'red')
      this.button(320, L('Отмена', 'Cancel'), () => this.showDetail(name))
    },

    send(names) {
      this.clear()
      this.view = 'sending'
      const title = this.text(110, 50, 30, COLOR.GRAY, L('Проверяю связь', 'Checking connection'))
      const big = this.text(170, 90, 72, COLOR.WHITE, '...')
      const info = this.text(270, 60, 26, COLOR.GRAY, L('часы → телефон → интернет', 'watch → phone → internet'))
      this.text(360, 40, 22, COLOR.GRAY, L('кнопка — выйти', 'button — exit'))
      const set = (a, b, c) => {
        title.setProperty(prop.MORE, { text: a })
        big.setProperty(prop.MORE, { text: b })
        info.setProperty(prop.MORE, { text: c })
      }
      this.uploader.check().then((problem) => {
        if (this.view !== 'sending') return
        if (problem) {
          this.failed(problem, names)
          return
        }
        this.uploader
          .uploadAll(names, (p) => {
            const n = p.index + 1
            const label =
              p.total > 1 ? L('Отправка ' + n + ' из ' + p.total, 'Sending ' + n + ' of ' + p.total) : L('Отправка', 'Sending')
            set(label, p.percent + '%', p.speed ? p.speed + L(' КБ/с', ' KB/s') : p.stage)
          })
          .then(
            () => {
              if (this.view !== 'sending') return
              this.clear()
              this.view = 'sent'
              this.text(150, 60, 34, COLOR.GREEN, L('Отправлено', 'Sent'))
              this.text(220, 80, 24, COLOR.GRAY, this.uploader.lastPath || 'Google Drive')
              this.timers.exit = later(() => this.showList(), 2500)
            },
            (e) => {
              if (this.view !== 'sending') return
              const lost = L('Связь с телефоном пропала', 'Lost connection to the phone')
              this.failed(e && typeof e.code === 'number' ? lost : errorText(e), names)
            },
          )
      })
    },

    failed(problem, names) {
      this.clear()
      this.view = 'failed'
      this.text(80, 50, 32, COLOR.RED, L('Не отправлено', 'Not sent'))
      this.text(135, 80, 26, COLOR.GRAY, problem + L('\nзапись сохранена на часах', '\nsaved on the watch'))
      this.button(240, L('Повторить', 'Retry'), () => this.send(names.filter((n) => fileSize(n))), 'green')
      this.button(320, L('Назад', 'Back'), () => this.showList())
    },

    // ---------- кнопка на корпусе ----------

    onKeyEvent(keyEvent) {
      if (keyEvent !== KEY_EVENT_CLICK && keyEvent !== KEY_EVENT_LONG_PRESS) return true
      if (this.view === 'detail' || this.view === 'confirm' || this.view === 'failed') this.showList()
      else exit()
      return true
    },
  }),
)
