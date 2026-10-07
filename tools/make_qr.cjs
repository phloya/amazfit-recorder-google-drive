// Рисует QR-код из test_out/preview_url.txt в test_out/preview_qr.png (для сканирования в Zepp).
const fs = require('fs')
const path = require('path')
const QRCode = require('qrcode')

const dir = path.join(__dirname, '..', 'test_out')
const url = fs.readFileSync(path.join(dir, 'preview_url.txt'), 'utf8').trim()
QRCode.toFile(path.join(dir, 'preview_qr.png'), url, { width: 720, margin: 3, errorCorrectionLevel: 'M' })
  .then(() => console.log('QR:', path.join(dir, 'preview_qr.png')))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
