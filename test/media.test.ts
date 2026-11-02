import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Approvals } from '../src/daemon/approvals'
import { Service } from '../src/daemon/service'
import { SessionHub } from '../src/daemon/sessions'
import { ConfigStore } from '../src/shared/config'
import { downloadFileName, fmtBytes, safeFileName } from '../src/shared/media'
import { ANNA, FakeTelegram, LEO } from './fake-telegram'

describe('file names', () => {
  test('keeps only a plain base name', () => {
    expect(safeFileName('../../.ssh/authorized_keys')).toBe('authorized_keys')
    expect(safeFileName('..\\..\\evil.bat')).toBe('evil.bat')
    expect(safeFileName('.hidden')).toBe('hidden')
    expect(safeFileName('a\u0000b<c>.pdf')).toBe('ab_c_.pdf')
    expect(safeFileName('රිපෝට් 2026.pdf')).toBe('රිපෝට් 2026.pdf')
    expect(safeFileName('...')).toBe('')
  })

  test('long names keep their extension', () => {
    const n = safeFileName(`${'x'.repeat(300)}.pdf`)
    expect(n.length).toBe(120)
    expect(n.endsWith('.pdf')).toBe(true)
  })

  test('prefixes the message id and names unnamed media by type', () => {
    expect(downloadFileName(7, { name: 'Archive.zip', type: 'document', mime: 'application/zip' })).toBe('7-Archive.zip')
    expect(downloadFileName(8, { name: null, type: 'photo', mime: 'image/jpeg' })).toBe('8-photo.jpg')
    expect(downloadFileName(9, { name: null, type: 'voice', mime: 'audio/ogg' })).toBe('9-voice.ogg')
    expect(downloadFileName(10, { name: '../', type: 'document', mime: null })).toBe('10-document')
  })

  test('sizes', () => {
    expect(fmtBytes(500)).toBe('500 B')
    expect(fmtBytes(1490302)).toBe('1.4 MB')
  })
})

describe('telegram_download_media', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'tgmcp-'))
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({ chats: { leo: { id: LEO.id, username: 'leo_p', name: LEO.name } }, rules: {} }))
    const tg = new FakeTelegram().add(LEO, ANNA)
    const downloadsDir = join(dir, 'downloads')
    const svc = new Service({
      store: new ConfigStore(path),
      tg,
      hub: new SessionHub(),
      approvals: new Approvals(),
      eventsUrl: () => 'ws://x',
      downloadsDir,
    })
    return { tg, svc, downloadsDir }
  }

  test('saves into a folder named after the nickname and returns the path', async () => {
    const { tg, svc, downloadsDir } = setup()
    tg.files.set(`${LEO.id}:42`, { name: 'report.pdf', type: 'document', mime: 'application/pdf', data: '%PDF-1.7' })
    const r = await svc.call('s1', 'telegram_download_media', { chat: 'leo', messageId: 42 })
    expect(r.isError).toBeFalsy()
    const saved = join(downloadsDir, 'leo', '42-report.pdf')
    expect(r.text).toContain(saved)
    expect(r.text).toContain('application/pdf')
    expect(readFileSync(saved, 'utf8')).toBe('%PDF-1.7')
  })

  test('a chat without a nickname gets a folder named by its id', async () => {
    const { tg, svc, downloadsDir } = setup()
    tg.files.set(`${ANNA.id}:5`, { name: null, type: 'photo', mime: 'image/jpeg', data: 'jpg' })
    const r = await svc.call('s1', 'telegram_download_media', { chat: ANNA.id, messageId: 5 })
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain(join(downloadsDir, String(ANNA.id), '5-photo.jpg'))
  })

  test('a message without an attachment is an error', async () => {
    const { svc } = setup()
    const r = await svc.call('s1', 'telegram_download_media', { chat: 'leo', messageId: 1 })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('nothing to download')
  })
})
