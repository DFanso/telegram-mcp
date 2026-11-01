import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Approvals } from '../src/daemon/approvals'
import { Service, describeMessage } from '../src/daemon/service'
import { SessionHub } from '../src/daemon/sessions'
import { ConfigStore } from '../src/shared/config'
import { ANNA, FakeTelegram, KYC, L2, LEO, LEONARDO } from './fake-telegram'

const FOOTER = '\n\n✨ sᴇɴᴛ ᴠɪᴀ ᴄʟᴀᴜᴅᴇ'

let tg: FakeTelegram
let hub: SessionHub
let store: ConfigStore
let svc: Service
let path: string

function setup(config: object) {
  const dir = mkdtempSync(join(tmpdir(), 'tgmcp-'))
  path = join(dir, 'config.json')
  writeFileSync(path, JSON.stringify({ footer: FOOTER, ...config }))
  tg = new FakeTelegram().add(LEO, LEONARDO, ANNA, KYC, L2)
  hub = new SessionHub()
  store = new ConfigStore(path)
  svc = new Service({ store, tg, hub, approvals: new Approvals(), eventsUrl: sid => `ws://x/events?session=${sid}` })
  hub.attachProxy('s1', { label: 'one', channel: false, watches: [] }, { send() {} })
  hub.attachProxy('s2', { label: 'two', channel: false, watches: [] }, { send() {} })
  tg.onMessage(m => hub.dispatch(m, x => describeMessage(store, x)))
}

const baseConfig = {
  chats: {
    leo: { id: LEO.id, username: 'leo_p', name: LEO.name },
    leonardo: { id: LEONARDO.id, username: 'leonardo_s', name: LEONARDO.name },
    anna: { id: ANNA.id, username: 'anna_k', name: ANNA.name },
    kyc: { id: KYC.id, name: 'KYC', topicId: 246 },
    l2: { id: L2.id, name: 'System Testing L2' },
  },
  rules: { blocked: [4243362352], requireApproval: ['kyc'], autoSend: ['leo', 'l2'], autoReply: ['anna'] },
}

describe('sending', () => {
  beforeEach(() => setup(baseConfig))

  test('autoSend goes out at once with the footer exactly once', async () => {
    const r = await svc.call('s1', 'telegram_send_message', { to: 'leo', text: 'hi' })
    expect(r.isError).toBeFalsy()
    expect(tg.sent).toEqual([{ chatId: LEO.id, text: `hi${FOOTER}`, opts: { replyTo: undefined, topicId: undefined, parseMode: 'plain' } }])
    await svc.call('s1', 'telegram_send_message', { to: 'leo', text: `again${FOOTER}` })
    expect(tg.sent[1]!.text).toBe(`again${FOOTER}`)
  })

  test('blocked by raw id even though it is also on autoSend', async () => {
    const r = await svc.call('s1', 'telegram_send_message', { to: 'l2', text: 'hi' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('blocked')
    const byId = await svc.call('s1', 'telegram_send_message', { to: '-1004243362352', text: 'hi' })
    expect(byId.isError).toBe(true)
    expect(tg.sent).toHaveLength(0)
  })

  test('unknown names are refused with suggestions, never guessed', async () => {
    const r = await svc.call('s1', 'telegram_send_message', { to: 'leon', text: 'hi' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('No saved chat called "leon"')
    expect(r.text).toContain('leonardo')
    expect(tg.sent).toHaveLength(0)
  })

  test('approval: draft, confirm once, only from the same session', async () => {
    const r = await svc.call('s1', 'telegram_send_message', { to: 'kyc', text: 'please QA' })
    expect(r.approval).toBeDefined()
    expect(tg.sent).toHaveLength(0)
    const id = r.approval!.id

    const other = await svc.call('s2', 'telegram_confirm_send', { approvalId: id })
    expect(other.isError).toBe(true)
    expect(tg.sent).toHaveLength(0)

    const ok = await svc.call('s1', 'telegram_confirm_send', { approvalId: id })
    expect(ok.isError).toBeFalsy()
    expect(tg.sent).toHaveLength(1)
    expect(tg.sent[0]!.opts.topicId).toBe(246) // the nickname's default topic

    const twice = await svc.call('s1', 'telegram_confirm_send', { approvalId: id })
    expect(twice.isError).toBe(true)
    expect(tg.sent).toHaveLength(1)
  })

  test('confirm re-checks the rules: a chat blocked after drafting is not sent', async () => {
    const r = await svc.call('s1', 'telegram_send_message', { to: 'kyc', text: 'x' })
    store.update(c => {
      c.rules.blocked.push('kyc')
    })
    const ok = await svc.call('s1', 'telegram_confirm_send', { approvalId: r.approval!.id })
    expect(ok.isError).toBe(true)
    expect(tg.sent).toHaveLength(0)
  })

  test('autoReply sends only while this session watches the chat', async () => {
    const before = await svc.call('s1', 'telegram_send_message', { to: 'anna', text: 'x' })
    expect(before.approval).toBeDefined()
    await svc.call('s1', 'telegram_watch', { chat: 'anna' })
    const during = await svc.call('s1', 'telegram_send_message', { to: 'anna', text: 'y' })
    expect(during.approval).toBeUndefined()
    expect(tg.sent).toHaveLength(1)
    // Another session isn't watching, so it still needs approval.
    const s2 = await svc.call('s2', 'telegram_send_message', { to: 'anna', text: 'z' })
    expect(s2.approval).toBeDefined()
  })

  test('a nickname whose username changed is not sent to', async () => {
    tg.add({ ...LEO, username: 'leo_new' })
    const r = await svc.call('s1', 'telegram_send_message', { to: 'leo', text: 'x' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('@leo_new')
    expect(tg.sent).toHaveLength(0)
    const read = await svc.call('s1', 'telegram_read_messages', { chat: 'leo' })
    expect(read.isError).toBeFalsy()
    expect(read.text).toContain('Warning')
  })

  test('a username that now belongs to a different id is refused', async () => {
    tg.uncached.add(LEO.id)
    tg.peers.delete(LEO.id)
    tg.add({ ...LEONARDO, id: 99, username: 'leo_p', name: 'Someone Else' })
    const r = await svc.call('s1', 'telegram_send_message', { to: 'leo', text: 'x' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('Not using it')
    expect(tg.sent).toHaveLength(0)
  })
})

describe('saved chats', () => {
  beforeEach(() => setup(baseConfig))

  test('save by username stores id, username and name', async () => {
    tg.add({ id: 50, type: 'user', name: 'Kaveesha', username: 'kav' })
    const r = await svc.call('s1', 'telegram_save_chat', { nickname: 'Kav', chat: '@kav', aliases: ['kaveesha'] })
    expect(r.isError).toBeFalsy()
    const saved = JSON.parse(readFileSync(path, 'utf8')).chats.kav
    expect(saved).toMatchObject({ id: 50, username: 'kav', name: 'Kaveesha', type: 'user', aliases: ['kaveesha'] })
    const send = await svc.call('s1', 'telegram_send_message', { to: 'kaveesha', text: 'x' })
    expect(send.approval).toBeDefined() // in no list: default approve
  })

  test('will not repoint a nickname without overwrite', async () => {
    tg.add({ id: 51, type: 'user', name: 'Other', username: 'other' })
    const r = await svc.call('s1', 'telegram_save_chat', { nickname: 'leonardo', chat: '@other' })
    expect(r.isError).toBe(true)
    const ok = await svc.call('s1', 'telegram_save_chat', { nickname: 'leonardo', chat: '@other', overwrite: true })
    expect(ok.isError).toBeFalsy()
  })

  test('names used by the rules cannot be repointed, created or removed by a session', async () => {
    tg.add({ id: 51, type: 'user', name: 'Other', username: 'other' })
    const repoint = await svc.call('s1', 'telegram_save_chat', { nickname: 'leo', chat: '@other', overwrite: true })
    expect(repoint.isError).toBe(true)
    const remove = await svc.call('s1', 'telegram_remove_chat', { nickname: 'leo' })
    expect(remove.isError).toBe(true)
    store.update(c => {
      c.rules.autoSend.push('boss')
    })
    const sneaky = await svc.call('s1', 'telegram_save_chat', { nickname: 'x', chat: '@other', aliases: ['boss'] })
    expect(sneaky.isError).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8')).chats.leo.id).toBe(LEO.id)
  })

  test('alias clashes are refused', async () => {
    tg.add({ id: 51, type: 'user', name: 'Other', username: 'other' })
    const r = await svc.call('s1', 'telegram_save_chat', { nickname: 'x', chat: '@other', aliases: ['leonardo'] })
    expect(r.isError).toBe(true)
  })
})

describe('watching', () => {
  beforeEach(() => setup(baseConfig))

  test('watch, receive via get_events, unwatch', async () => {
    const w = await svc.call('s1', 'telegram_watch', { chat: 'leo', note: 'waiting for the build link' })
    expect(w.text).toContain('Monitor')
    tg.emit(LEO.id, 'here you go')
    const e = await svc.call('s1', 'telegram_get_events', {})
    expect(e.text).toContain('here you go')
    expect(e.text).toContain('Leo Perera (@leo_p)')
    expect(e.text).toContain('[leo]')

    // Other sessions see nothing.
    expect((await svc.call('s2', 'telegram_get_events', {})).text).toBe('No new watched messages.')

    await svc.call('s1', 'telegram_unwatch', { all: true })
    tg.emit(LEO.id, 'after stop')
    expect((await svc.call('s1', 'telegram_get_events', {})).text).toBe('No new watched messages.')
  })

  test('from filter inside a group, with the nickname topic', async () => {
    tg.add({ id: 50, type: 'user', name: 'Kaveesha', username: 'kav' })
    await svc.call('s1', 'telegram_watch', { chat: 'kyc', from: '@kav' })
    tg.emit(KYC.id, 'from someone else', LEO.id, { topicId: 246 })
    tg.emit(KYC.id, 'wrong topic', 50, { topicId: 1 })
    tg.emit(KYC.id, 'QA done', 50, { topicId: 246 })
    const e = await svc.call('s1', 'telegram_get_events', {})
    expect(e.text).toContain('QA done')
    expect(e.text).not.toContain('someone else')
    expect(e.text).not.toContain('wrong topic')
  })
})

test('invalid arguments come back as an error, not a crash', async () => {
  setup(baseConfig)
  const r = await svc.call('s1', 'telegram_send_message', { to: 'leo' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('Invalid arguments')
})
