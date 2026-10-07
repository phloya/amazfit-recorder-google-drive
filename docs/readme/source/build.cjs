// Генератор картинок для README: node docs/readme/source/build.cjs
// Делает английские (hero.svg…) и русские (hero.ru.svg…) версии.
// Экраны часов повторяют настоящую разметку приложения (круглый экран 480×480).
const fs = require('fs')
const path = require('path')

const OUT = path.join(__dirname, '..')

const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

const C = {
  bg: '#0e0f11',
  panel: '#15171a',
  line: '#26282d',
  fg: '#f2f2f7',
  soft: '#c7c7cc',
  muted: '#8e8e93',
  dim: '#5f636b',
  red: '#ff3b30',
  btn: '#2c2c2e',
  btnGreen: '#1f5c2e',
  case: '#232529',
  bezel: '#3a3d42',
  strap: '#17181b',
}

// Все тексты: на экранах часов — те же строки, что в приложении (page/*.js)
const T = {
  en: {
    badge: 'Google Drive integration',
    tagline: ['One button on your wrist.', 'Every recording lands in Google Drive,', 'sorted into a folder per day.'],
    meta: 'Opus 16 kHz → Bluetooth → Apps Script → Drive',
    rec: 'RECORDING',
    recHint: 'press 3 times to stop',
    notSent: 'Not sent',
    noInternet: 'No internet on the phone',
    saved: 'Saved on the watch: 2',
    retry: 'Retry',
    records: 'Records',
    later: 'button — later',
    notSentN: 'Not sent: 2',
    sendAll: 'Send all',
    exit: 'button — exit',
    cards: [
      ['Recording', 'press 3 times to stop'],
      ['No connection', 'saved on the watch'],
      ['Records', 'send or delete later'],
    ],
    nodes: [
      ['Watch', 'records Opus,', '16 kHz mono'],
      ['Zepp app', 'gets it over Bluetooth,', 'wraps it as Ogg'],
      ['Apps Script', 'in your Google', 'account, via HTTPS'],
    ],
    root: 'Recorder/',
    note: 'Until Drive confirms a file, it stays on the watch and waits in Records.',
    heroDesc: 'Title and an Amazfit Balance 2 showing the recording screen: current time 23:14, a red dot, RECORDING, a 12:48 timer and the hint to press the button three times to stop.',
    screensTitle: 'Three watch screens',
    screensDesc: 'Recording screen with a timer; the no-connection screen that keeps the file on the watch with Retry and Records buttons; and the Records list with Send all and two saved recordings.',
    flowTitle: 'How a recording travels',
    flowDesc: 'The watch records Opus audio, the Zepp app on the phone receives it over Bluetooth and wraps it as Ogg, a Google Apps Script in your account saves it to Google Drive under Recorder/2026/10/07/. A file stays on the watch until Drive confirms it.',
  },
  ru: {
    badge: 'Интеграция с Google Drive',
    tagline: ['Одна кнопка на запястье.', 'Каждая запись — в Google Drive,', 'в папку по дням.'],
    meta: 'Opus 16 кГц → Bluetooth → Apps Script → Drive',
    rec: 'ЗАПИСЬ',
    recHint: 'кнопка 3 раза — стоп',
    notSent: 'Не отправлено',
    noInternet: 'На телефоне нет интернета',
    saved: 'Сохранено на часах: 2',
    retry: 'Повторить',
    records: 'Записи',
    later: 'кнопка — позже',
    notSentN: 'Не отправлено: 2',
    sendAll: 'Отправить все',
    exit: 'кнопка — выход',
    cards: [
      ['Запись', 'нажать 3 раза — стоп'],
      ['Нет связи', 'запись ждёт на часах'],
      ['Записи', 'отправить или удалить'],
    ],
    nodes: [
      ['Часы', 'пишут звук Opus,', '16 кГц, моно'],
      ['Приложение Zepp', 'по Bluetooth,', 'упаковывает в Ogg'],
      ['Apps Script', 'в вашем аккаунте', 'Google, по HTTPS'],
    ],
    root: 'Диктофон/',
    note: 'Пока Drive не подтвердил файл, он хранится на часах в «Записях».',
    heroDesc: 'Название и часы Amazfit Balance 2 с экраном записи: время 23:14, красная точка, ЗАПИСЬ, таймер 12:48 и подсказка нажать кнопку три раза для остановки.',
    screensTitle: 'Три экрана часов',
    screensDesc: 'Экран записи с таймером; экран «нет связи», где файл остаётся на часах, с кнопками «Повторить» и «Записи»; список записей с «Отправить все» и двумя записями.',
    flowTitle: 'Путь записи',
    flowDesc: 'Часы пишут звук Opus, приложение Zepp на телефоне получает его по Bluetooth и упаковывает в Ogg, скрипт Google Apps Script в вашем аккаунте кладёт файл в Google Drive: Диктофон/2026/10/07/. Пока Drive не подтвердил файл, он хранится на часах.',
  },
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function text(x, y, value, { size = 20, color = C.fg, weight = 400, anchor = 'start', font = SANS, extra = '' } = {}) {
  return `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}"${extra}>${esc(value)}</text>`
}

// ---------- экран часов ----------
// Координаты внутри экрана заданы как в приложении (0..480), s — масштаб.
function watchScreen(cx, cy, r, items) {
  const s = r / 240
  const X = (v) => +(cx - r + v * s).toFixed(1)
  const Y = (v) => +(cy - r + v * s).toFixed(1)
  const parts = [`<circle cx="${cx}" cy="${cy}" r="${r}" fill="#000"/>`]
  for (const it of items) {
    if (it.type === 'text') {
      // центр строки (как align_v CENTER у Zepp OS) → базовая линия
      const base = it.cy + it.size * 0.36
      parts.push(text(X(240), Y(base), it.value, { size: +(it.size * s).toFixed(1), color: it.color, weight: it.weight || 400, anchor: 'middle' }))
    } else if (it.type === 'dot') {
      parts.push(`<circle cx="${X(240)}" cy="${Y(it.cy)}" r="${+(it.r * s).toFixed(1)}" fill="${C.red}"/>`)
    } else if (it.type === 'button') {
      parts.push(`<rect x="${X(it.x)}" y="${Y(it.y)}" width="${+(it.w * s).toFixed(1)}" height="${+(it.h * s).toFixed(1)}" rx="${+((it.h / 2) * s).toFixed(1)}" fill="${it.fill}"/>`)
      parts.push(text(X(it.x + it.w / 2), Y(it.y + it.h / 2 + it.size * 0.36), it.value, { size: +(it.size * s).toFixed(1), color: C.fg, anchor: 'middle' }))
    }
  }
  return parts.join('\n    ')
}

function watchCase(cx, cy, r, { straps = false } = {}) {
  const outer = r + 20
  const parts = []
  if (straps) {
    parts.push(`<rect x="${cx - r * 0.62}" y="${cy - outer - 400}" width="${r * 1.24}" height="400" rx="26" fill="${C.strap}"/>`)
    parts.push(`<rect x="${cx - r * 0.62}" y="${cy + outer}" width="${r * 1.24}" height="400" rx="26" fill="${C.strap}"/>`)
    // кнопки справа: коронка и нижняя кнопка
    parts.push(`<rect x="${cx + outer - 6}" y="${cy - 72}" width="20" height="46" rx="7" fill="${C.bezel}"/>`)
    parts.push(`<rect x="${cx + outer - 6}" y="${cy + 30}" width="16" height="36" rx="6" fill="${C.bezel}"/>`)
  }
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${outer}" fill="${C.case}"/>`)
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${r + 7}" fill="none" stroke="${C.bezel}" stroke-width="3"/>`)
  return parts.join('\n    ')
}

// Состояния экранов
function screensFor(t) {
  return {
    recording: [
      { type: 'text', cy: 60, size: 34, color: C.soft, value: '23:14' },
      { type: 'dot', cy: 115, r: 16 },
      { type: 'text', cy: 168, size: 30, color: C.muted, value: t.rec },
      { type: 'text', cy: 235, size: 76, color: C.fg, value: '12:48' },
      { type: 'text', cy: 370, size: 24, color: C.muted, value: t.recHint },
    ],
    offline: [
      { type: 'text', cy: 60, size: 34, color: C.soft, value: '23:15' },
      { type: 'text', cy: 168, size: 30, color: C.muted, value: t.notSent },
      { type: 'text', cy: 235, size: 76, color: C.red, value: '!' },
      { type: 'text', cy: 293, size: 26, color: C.muted, value: t.noInternet },
      { type: 'text', cy: 324, size: 26, color: C.muted, value: t.saved },
      { type: 'button', x: 62, y: 352, w: 170, h: 64, fill: C.btnGreen, size: 26, value: t.retry },
      { type: 'button', x: 248, y: 352, w: 170, h: 64, fill: C.btn, size: 26, value: t.records },
      { type: 'text', cy: 437, size: 22, color: C.muted, value: t.later },
    ],
    records: [
      { type: 'text', cy: 75, size: 30, color: C.fg, value: t.notSentN },
      { type: 'button', x: 90, y: 110, w: 300, h: 62, fill: C.btnGreen, size: 28, value: t.sendAll },
      { type: 'button', x: 90, y: 190, w: 300, h: 62, fill: C.btn, size: 28, value: '07.10 · 23:14 · 12:48' },
      { type: 'button', x: 90, y: 262, w: 300, h: 62, fill: C.btn, size: 28, value: '07.10 · 18:02 · 0:41' },
      { type: 'text', cy: 427, size: 22, color: C.muted, value: t.exit },
    ],
  }
}

function svg(w, h, title, desc, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="title desc">
  <title id="title">${esc(title)}</title>
  <desc id="desc">${esc(desc)}</desc>
  ${body}
</svg>
`
}

// Ширина плашки под текст: 22px, полужирный ≈ 0.54 em на символ, плюс значок папки и поля
function badgeWidth(label) {
  return Math.round(76 + label.length * 22 * 0.54)
}

// ---------- hero ----------
function hero(t) {
  const W = 1200
  const H = 420
  const cx = 930
  const cy = 212
  const r = 160
  const body = `<defs>
    <clipPath id="card"><rect width="${W}" height="${H}" rx="28"/></clipPath>
  </defs>
  <rect width="${W}" height="${H}" rx="28" fill="${C.bg}"/>
  <g id="title-block">
    ${text(64, 88, 'ZEPP OS · AMAZFIT BALANCE 2', { size: 20, color: C.muted, font: MONO, extra: ' letter-spacing="1.5"' })}
    ${text(64, 156, 'Amazfit Recorder', { size: 60, weight: 700 })}
    <rect x="64" y="176" width="${badgeWidth(t.badge)}" height="40" rx="20" fill="none" stroke="${C.dim}" stroke-width="2"/>
    <path d="M84 189 h10 l4 4 h14 v13 h-28 z" fill="none" stroke="${C.soft}" stroke-width="2" stroke-linejoin="round"/>
    ${text(124, 204, t.badge, { size: 22, color: C.fg, weight: 600 })}
    ${text(64, 262, t.tagline[0], { size: 28, color: C.soft })}
    ${text(64, 300, t.tagline[1], { size: 28, color: C.soft })}
    ${text(64, 338, t.tagline[2], { size: 28, color: C.soft })}
    <circle cx="72" cy="381" r="7" fill="${C.red}"/>
    ${text(90, 387, t.meta, { size: 18, color: C.muted, font: MONO })}
  </g>
  <g id="watch" clip-path="url(#card)">
    ${watchCase(cx, cy, r, { straps: true })}
    ${watchScreen(cx, cy, r, screensFor(t).recording)}
  </g>`
  return svg(W, H, 'Amazfit Recorder · ' + t.badge, t.heroDesc, body)
}

// ---------- три экрана ----------
function screens(t) {
  const W = 1200
  const H = 470
  const r = 148
  const cy = 200
  const s = screensFor(t)
  const cols = [
    { x: 216, screen: s.recording, card: t.cards[0] },
    { x: 600, screen: s.offline, card: t.cards[1] },
    { x: 984, screen: s.records, card: t.cards[2] },
  ]
  const parts = [`<rect width="${W}" height="${H}" rx="28" fill="${C.bg}"/>`]
  for (const c of cols) {
    parts.push(`<g>
    ${watchCase(c.x, cy, r)}
    ${watchScreen(c.x, cy, r, c.screen)}
    ${text(c.x, 412, c.card[0], { size: 26, weight: 600, anchor: 'middle' })}
    ${text(c.x, 444, c.card[1], { size: 20, color: C.muted, anchor: 'middle' })}
  </g>`)
  }
  return svg(W, H, t.screensTitle, t.screensDesc, parts.join('\n  '))
}

// ---------- схема ----------
function arrow(x1, x2, y) {
  return `<path d="M${x1} ${y} H${x2 - 2}" stroke="${C.dim}" stroke-width="2.5" fill="none"/>
    <path d="M${x2 - 12} ${y - 8} L${x2} ${y} L${x2 - 12} ${y + 8}" stroke="${C.dim}" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
}

function flow(t) {
  const W = 1200
  const H = 340
  const iy = 104 // центр значков
  const node = (x, icon, [title, l1, l2]) => `<g>
    ${icon}
    ${text(x, 196, title, { size: 24, weight: 600, anchor: 'middle' })}
    ${text(x, 228, l1, { size: 20, color: C.muted, anchor: 'middle' })}
    ${text(x, 256, l2, { size: 20, color: C.muted, anchor: 'middle' })}
  </g>`
  const watchIcon = `<circle cx="138" cy="${iy}" r="38" fill="#000" stroke="${C.muted}" stroke-width="3"/>
    <rect x="175" y="${iy - 16}" width="9" height="20" rx="3" fill="${C.muted}"/>
    <circle cx="138" cy="${iy}" r="10" fill="${C.red}"/>`
  const phoneIcon = `<rect x="368" y="${iy - 40}" width="48" height="80" rx="10" fill="none" stroke="${C.muted}" stroke-width="3"/>
    <rect x="384" y="${iy + 28}" width="16" height="3" rx="1.5" fill="${C.muted}"/>`
  const scriptIcon = `<path d="M618 ${iy - 38} h34 l16 16 v60 h-50 z" fill="none" stroke="${C.muted}" stroke-width="3" stroke-linejoin="round"/>
    ${text(643, iy + 14, '{ }', { size: 22, color: C.muted, anchor: 'middle', font: MONO })}`
  const tree = `<g>
    <rect x="806" y="42" width="346" height="238" rx="20" fill="${C.panel}" stroke="${C.line}" stroke-width="2"/>
    <path d="M832 78 h18 l6 7 h26 v22 h-50 z" fill="none" stroke="${C.muted}" stroke-width="2.5" stroke-linejoin="round"/>
    ${text(896, 102, 'Google Drive', { size: 24, weight: 600 })}
    ${text(832, 146, t.root, { size: 20, color: C.soft, font: MONO })}
    ${text(846, 178, '└ 2026/10/07/', { size: 20, color: C.soft, font: MONO })}
    ${text(866, 210, '├ 2026-10-07_18-02-11.ogg', { size: 18, color: C.muted, font: MONO })}
    ${text(866, 240, '└ 2026-10-07_23-14-02.ogg', { size: 18, color: C.fg, font: MONO })}
  </g>`
  const body = `<rect width="${W}" height="${H}" rx="28" fill="${C.bg}"/>
  ${node(138, watchIcon, t.nodes[0])}
  ${arrow(228, 300, iy)}
  ${node(392, phoneIcon, t.nodes[1])}
  ${arrow(484, 556, iy)}
  ${node(643, scriptIcon, t.nodes[2])}
  ${arrow(732, 800, iy)}
  ${tree}
  <circle cx="72" cy="307" r="7" fill="${C.red}"/>
  ${text(90, 314, t.note, { size: 20, color: C.muted })}`
  return svg(W, H, t.flowTitle, t.flowDesc, body)
}

for (const [lang, suffix] of [['en', ''], ['ru', '.ru']]) {
  const t = T[lang]
  fs.writeFileSync(path.join(OUT, `hero${suffix}.svg`), hero(t))
  fs.writeFileSync(path.join(OUT, `screens${suffix}.svg`), screens(t))
  fs.writeFileSync(path.join(OUT, `flow${suffix}.svg`), flow(t))
}
console.log('written: hero, screens, flow (.svg and .ru.svg)')
