import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Approvals } from '../src/daemon/approvals'
import { Service } from '../src/daemon/service'
import { SessionHub } from '../src/daemon/sessions'
import { ConfigStore } from '../src/shared/config'
import { checkSendable, downloadFileName, fmtBytes, safeFileName } from '../src/shared/media'
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

describe('telegram_send_file', () => {
  const FOOTER = '\n\n-- sent by a bot'

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'tgmcp-'))
    const mcpHome = join(dir, 'mcp')
    mkdirSync(mcpHome)
    const path = join(mcpHome, 'config.json')
    writeFileSync(
      path,
      JSON.stringify({
        footer: FOOTER,
        chats: { leo: { id: LEO.id, username: 'leo_p', name: LEO.name }, anna: { id: ANNA.id, username: 'anna_k', name: ANNA.name } },
        rules: { autoSend: ['leo'], requireApproval: ['anna'] },
      }),
    )
    const tg = new FakeTelegram().add(LEO, ANNA)
    const approvals = new Approvals()
    const svc = new Service({ store: new ConfigStore(path), tg, hub: new SessionHub(), approvals, eventsUrl: () => 'ws://x', mcpHome })
    const report = join(dir, 'report.pdf')
    writeFileSync(report, '%PDF-1.7 hello')
    return { tg, svc, dir, mcpHome, report }
  }

  test('an autoSend chat gets the file at once, with the footer as caption', async () => {
    const { tg, svc, report } = setup()
    const r = await svc.call('s1', 'telegram_send_file', { to: 'leo', path: report, caption: 'Q3 numbers' })
    expect(r.isError).toBeFalsy()
    expect(tg.sentFiles).toHaveLength(1)
    expect(tg.sentFiles[0]!.file).toEqual({ path: realpathSync(report), name: 'report.pdf', size: 14 })
    expect(tg.sentFiles[0]!.caption).toBe(`Q3 numbers${FOOTER}`)
    expect(tg.sent).toHaveLength(0)
  })

  test('no caption still gets the footer, without leading blank lines', async () => {
    const { tg, svc, report } = setup()
    await svc.call('s1', 'telegram_send_file', { to: 'leo', path: report })
    expect(tg.sentFiles[0]!.caption).toBe(FOOTER.trim())
  })

  test('a chat that needs approval waits, shows the file, and sends it once approved', async () => {
    const { tg, svc, report } = setup()
    const r = await svc.call('s1', 'telegram_send_file', { to: 'anna', path: report, caption: 'hi' })
    expect(r.approval).toBeDefined()
    expect(r.approval!.text).toContain('[file: report.pdf, 14 B]')
    expect(tg.sentFiles).toHaveLength(0)
    expect(svc.uiState().approvals[0]!.text).toContain('[file: report.pdf')
    const ok = await svc.call('s1', 'telegram_confirm_send', { approvalId: r.approval!.id })
    expect(ok.isError).toBeFalsy()
    expect(tg.sentFiles).toHaveLength(1)
    expect(svc.uiState().recent.at(-1)!.text).toContain('[file: report.pdf')
  })

  test('a file replaced while waiting for approval is not sent', async () => {
    const { tg, svc, report } = setup()
    const r = await svc.call('s1', 'telegram_send_file', { to: 'anna', path: report })
    writeFileSync(report, 'something else entirely, not what the user approved')
    const res = await svc.call('s1', 'telegram_confirm_send', { approvalId: r.approval!.id })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('changed after approval was asked')
    expect(tg.sentFiles).toHaveLength(0)
  })

  test('the approver sees the full path, not just the file name', async () => {
    const { svc, report } = setup()
    const r = await svc.call('s1', 'telegram_send_file', { to: 'anna', path: report, caption: 'hi' })
    expect(r.approval!.text).toContain(`Path: ${realpathSync(report)}`)
    expect(r.text).toContain(`Path: ${realpathSync(report)}`)
    expect(svc.uiState().approvals[0]!.text).toContain(`Path: ${realpathSync(report)}`)
  })

  test('a file deleted while waiting for approval is not sent', async () => {
    const { tg, svc, report } = setup()
    const r = await svc.call('s1', 'telegram_send_file', { to: 'anna', path: report })
    rmSync(report)
    const res = await svc.call('s1', 'telegram_confirm_send', { approvalId: r.approval!.id })
    expect(res.isError).toBe(true)
    expect(tg.sentFiles).toHaveLength(0)
  })

  test('refuses credentials, its own files, relative paths and folders', async () => {
    const { tg, svc, dir, mcpHome } = setup()
    const home = join(dir, 'home')
    mkdirSync(join(home, '.ssh'), { recursive: true })
    writeFileSync(join(home, '.ssh', 'config'), 'Host x')
    writeFileSync(join(dir, '.env'), 'SECRET=1')
    writeFileSync(join(dir, 'id_ed25519'), 'key')
    writeFileSync(join(dir, 'server.pem'), 'key')
    writeFileSync(join(mcpHome, 'session.db'), 'auth key')
    symlinkSync(join(mcpHome, 'session.db'), join(dir, 'innocent.txt'))
    for (const path of [join(dir, '.env'), join(dir, 'id_ed25519'), join(dir, 'server.pem'), join(mcpHome, 'session.db'), join(dir, 'innocent.txt')]) {
      const r = await svc.call('s1', 'telegram_send_file', { to: 'leo', path })
      expect(r.isError).toBe(true)
      expect(r.text).toContain('Refusing')
    }
    expect(() => checkSendable(join(home, '.ssh', 'config'), { mcpHome, home })).toThrow('Refusing')
    expect((await svc.call('s1', 'telegram_send_file', { to: 'leo', path: 'report.pdf' })).text).toContain('absolute path')
    expect((await svc.call('s1', 'telegram_send_file', { to: 'leo', path: dir })).text).toContain('Not a regular file')
    expect((await svc.call('s1', 'telegram_send_file', { to: 'leo', path: join(dir, 'nope') })).text).toContain('No such file')
    expect(tg.sentFiles).toHaveLength(0)
  })
})
