// Приёмник записей с часов: складывает их в Google Drive → ROOT_FOLDER/ГГГГ/ММ/ДД/
// Развернуть: Развернуть → Новое развертывание → Веб-приложение,
// «Запуск от имени»: я, «У кого есть доступ»: все.

const TOKEN = 'CHANGE_ME' // любая длинная случайная строка; такая же — в app-side/config.js
const ROOT_FOLDER = 'Recorder' // папка в корне Drive, например 'Диктофон'
const SESSION_TTL_MS = 6 * 24 * 3600 * 1000 // Drive держит сессию загрузки неделю

function doGet() {
  return json_({ ok: true, service: 'amazfit-recorder' })
}

// Каждый ответ содержит action: так телефон отличит настоящий ответ от случайной страницы
function doPost(e) {
  let action = ''
  try {
    const req = JSON.parse(e.postData.contents)
    action = req.action
    if (TOKEN === 'CHANGE_ME') return reply_(action, { ok: false, error: 'set TOKEN in Code.gs' })
    if (req.token !== TOKEN) return reply_(action, { ok: false, error: 'forbidden' })
    switch (action) {
      case 'ping':
        return reply_(action, { ok: true, folder: getFolder_([ROOT_FOLDER]).getName() })
      case 'start':
        return reply_(action, start_(req))
      case 'chunk':
        return reply_(action, chunk_(req))
      case 'status':
        return reply_(action, status_(req))
      default:
        return reply_(action, { ok: false, error: 'unknown action' })
    }
  } catch (err) {
    return reply_(action, { ok: false, error: String((err && err.message) || err) })
  }
}

function start_(req) {
  const folder = getFolder_([ROOT_FOLDER].concat(req.folder || []))
  const meta = {
    name: req.name,
    parents: [folder.getId()],
    mimeType: 'audio/ogg',
    description: req.description || '',
  }
  const resp = UrlFetchApp.fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink',
    {
      method: 'post',
      contentType: 'application/json; charset=UTF-8',
      payload: JSON.stringify(meta),
      headers: {
        Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
        'X-Upload-Content-Type': 'audio/ogg',
      },
      muteHttpExceptions: true,
    },
  )
  if (resp.getResponseCode() !== 200) {
    return { ok: false, error: 'drive start ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 200) }
  }
  const headers = resp.getAllHeaders()
  const url = headers['Location'] || headers['location']
  if (!url) return { ok: false, error: 'drive start: нет адреса сессии' }
  saveSession_(req.uploadId, { url: url, path: [ROOT_FOLDER].concat(req.folder || [], [req.name]).join('/') })
  cleanup_()
  return { ok: true }
}

function chunk_(req) {
  const session = getSession_(req.uploadId)
  if (!session) return { ok: false, error: 'no_session' }
  if (session.done) return doneReply_(session) // повтор финального куска
  const bytes = Utilities.base64Decode(req.data || '')
  const start = req.offset
  const end = start + bytes.length - 1
  const total = req.final ? String(start + bytes.length) : '*'
  const range = bytes.length ? 'bytes ' + start + '-' + end + '/' + total : 'bytes */' + total
  const options = {
    method: 'put',
    contentType: 'audio/ogg',
    headers: { 'Content-Range': range, Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  }
  if (bytes.length) options.payload = bytes
  return driveResult_(req.uploadId, session, UrlFetchApp.fetch(session.url, options))
}

function status_(req) {
  const session = getSession_(req.uploadId)
  if (!session) return { ok: false, error: 'no_session' }
  if (session.done) return doneReply_(session)
  const resp = UrlFetchApp.fetch(session.url, {
    method: 'put',
    headers: { 'Content-Range': 'bytes */*', Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  })
  return driveResult_(req.uploadId, session, resp)
}

function driveResult_(uploadId, session, resp) {
  const code = resp.getResponseCode()
  if (code === 308) {
    const headers = resp.getAllHeaders()
    const range = headers['Range'] || headers['range'] || ''
    const m = /bytes=0-(\d+)/.exec(range)
    return { ok: true, done: false, received: m ? Number(m[1]) + 1 : 0 }
  }
  if (code === 200 || code === 201) {
    const file = JSON.parse(resp.getContentText())
    session.done = true
    session.fileId = file.id
    session.link = file.webViewLink
    saveSession_(uploadId, session)
    return doneReply_(session)
  }
  if (code === 404 || code === 410) return { ok: false, error: 'no_session' }
  return { ok: false, error: 'drive ' + code + ': ' + resp.getContentText().slice(0, 200) }
}

function doneReply_(session) {
  return { ok: true, done: true, fileId: session.fileId, link: session.link, path: session.path }
}

function saveSession_(uploadId, session) {
  session.t = session.t || Date.now()
  PropertiesService.getScriptProperties().setProperty('up_' + uploadId, JSON.stringify(session))
}

function getSession_(uploadId) {
  const raw = PropertiesService.getScriptProperties().getProperty('up_' + uploadId)
  return raw ? JSON.parse(raw) : null
}

function cleanup_() {
  const props = PropertiesService.getScriptProperties()
  const all = props.getProperties()
  const now = Date.now()
  Object.keys(all).forEach(function (key) {
    if (key.indexOf('up_') !== 0) return
    try {
      if (now - JSON.parse(all[key]).t > SESSION_TTL_MS) props.deleteProperty(key)
    } catch (e) {
      props.deleteProperty(key)
    }
  })
}

function getFolder_(names) {
  let folder = DriveApp.getRootFolder()
  names.forEach(function (name) {
    const it = folder.getFoldersByName(name)
    folder = it.hasNext() ? it.next() : folder.createFolder(name)
  })
  return folder
}

function reply_(action, obj) {
  obj.action = action
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON)
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON)
}

// Запустите один раз вручную в редакторе, чтобы выдать скрипту доступ к Drive.
function authorize() {
  getFolder_([ROOT_FOLDER])
  UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/about?fields=user', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
  })
}
