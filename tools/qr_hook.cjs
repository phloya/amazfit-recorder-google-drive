// Подключается к `zeus preview` через `node -r`: сохраняет ссылку из QR-кода в файл,
// чтобы можно было нарисовать крупную картинку для сканирования с экрана.
const fs = require('fs')
const path = require('path')
const qrTerminal = require('qrcode-terminal')

const original = qrTerminal.generate
qrTerminal.generate = function (text, opts, cb) {
  const out = path.join(__dirname, '..', 'test_out', 'preview_url.txt')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, String(text))
  console.log('[qr_hook] ссылка сохранена: ' + out)
  return original.call(this, text, opts, cb)
}
