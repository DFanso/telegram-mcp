import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Approvals } from '../src/daemon/approvals'
import { PAGE_REASON_MAX, Service, describeMessage, pageReason } from '../src/daemon/service'
import { SessionHub } from '../src/daemon/sessions'
import { ConfigStore } from '../src/shared/config'
import { ANNA, FakeTelegram, TEAM_QA, ALL_HANDS, LEO, LEONARDO } from './fake-telegram'

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
  tg = new FakeTelegram().add(LEO, LEONARDO, ANNA, TEAM_QA, ALL_HANDS)
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
    qa: { id: TEAM_QA.id, name: 'Team QA', topicId: 42 },
    allhands: { id: ALL_HANDS.id, name: 'Company All-Hands' },
  },
  rules: { blocked: [5550001111], requireApproval: ['qa'], autoSend: ['leo', 'allhands'], autoReply: ['anna', 'leo', 'qa'] },
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
    const r = await svc.call('s1', 'telegram_send_message', { to: 'allhands', text: 'hi' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('blocked')
    const byId = await svc.call('s1', 'telegram_send_message', { to: '-1005550001111', text: 'hi' })
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
    const r = await svc.call('s1', 'telegram_send_message', { to: 'qa', text: 'please QA' })
    expect(r.approval).toBeDefined()
    expect(tg.sent).toHaveLength(0)
    const id = r.approval!.id

    const other = await svc.call('s2', 'telegram_confirm_send', { approvalId: id })
    expect(other.isError).toBe(true)
    expect(tg.sent).toHaveLength(0)

    const ok = await svc.call('s1', 'telegram_confirm_send', { approvalId: id })
    expect(ok.isError).toBeFalsy()
    expect(tg.sent).toHaveLength(1)
    expect(tg.sent[0]!.opts.topicId).toBe(42) // the nickname's default topic

    const twice = await svc.call('s1', 'telegram_confirm_send', { approvalId: id })
    expect(twice.isError).toBe(true)
    expect(tg.sent).toHaveLength(1)
  })

  test('confirm re-checks the rules: a chat blocked after drafting is not sent', async () => {
    const r = await svc.call('s1', 'telegram_send_message', { to: 'qa', text: 'x' })
    store.update(c => {
      c.rules.blocked.push('qa')
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
    tg.add({ id: 50, type: 'user', name: 'Nadia', username: 'nad' })
    const r = await svc.call('s1', 'telegram_save_chat', { nickname: 'Nad', chat: '@nad', aliases: ['nadia'] })
    expect(r.isError).toBeFalsy()
    const saved = JSON.parse(readFileSync(path, 'utf8')).chats.nad
    expect(saved).toMatchObject({ id: 50, username: 'nad', name: 'Nadia', type: 'user', aliases: ['nadia'] })
    const send = await svc.call('s1', 'telegram_send_message', { to: 'nadia', text: 'x' })
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
    tg.add({ id: 50, type: 'user', name: 'Nadia', username: 'nad' })
    await svc.call('s1', 'telegram_watch', { chat: 'qa', from: '@nad' })
    tg.emit(TEAM_QA.id, 'from someone else', LEO.id, { topicId: 42 })
    tg.emit(TEAM_QA.id, 'wrong topic', 50, { topicId: 1 })
    tg.emit(TEAM_QA.id, 'QA done', 50, { topicId: 42 })
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

describe('autoReply subscriptions', () => {
  beforeEach(() => setup(baseConfig))

  test('only chats on the autoReply list can be watched', async () => {
    const r = await svc.call('s1', 'telegram_watch', { chat: 'leonardo' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('not on the autoReply list')
    expect(hub.watches('s1')).toHaveLength(0)
  })

  test('every subscribed session gets every message', async () => {
    await svc.call('s1', 'telegram_watch', { chat: 'anna' })
    const second = await svc.call('s2', 'telegram_watch', { chat: 'anna' })
    expect(second.text).toContain('1 other session(s) also watch this chat')
    tg.emit(ANNA.id, 'hello both')
    expect((await svc.call('s1', 'telegram_get_events', {})).text).toContain('hello both')
    expect((await svc.call('s2', 'telegram_get_events', {})).text).toContain('hello both')
  })

  test('watching a requireApproval chat still asks before replying', async () => {
    const w = await svc.call('s1', 'telegram_watch', { chat: 'qa' })
    expect(w.text).toContain('stricter rule')
    const r = await svc.call('s1', 'telegram_send_message', { to: 'qa', text: 'x' })
    expect(r.approval).toBeDefined()
  })
})

describe('menu bar approvals and the sent log', () => {
  beforeEach(() => setup(baseConfig))

  test('the menu bar can approve any session\'s draft; waiters hear the outcome', async () => {
    svc.touchUi()
    const r = await svc.call('s1', 'telegram_send_message', { to: 'qa', text: 'QA please' })
    expect(r.approval?.uiActive).toBe(true)
    expect(r.text).toContain('menu bar')
    const waiting = svc.call('s1', '__await_approval', { approvalId: r.approval!.id })

    const state = svc.uiState()
    expect(state.approvals).toHaveLength(1)
    expect(state.approvals[0]).toMatchObject({ id: r.approval!.id, sessionLabel: 'one' })

    const decided = await svc.decide(r.approval!.id, true, 'menubar', null)
    expect(decided.text).toContain('Approved in the menu bar')
    expect((await waiting).text).toContain('Approved in the menu bar')
    expect(tg.sent).toHaveLength(1)
    expect(svc.uiState().approvals).toHaveLength(0)
  })

  test('deny sends nothing and a second decision is refused', async () => {
    const r = await svc.call('s1', 'telegram_send_message', { to: 'qa', text: 'x' })
    expect(r.approval?.uiActive).toBe(false)
    const denied = await svc.decide(r.approval!.id, false, 'menubar', null)
    expect(denied.text).toContain('Declined in the menu bar')
    await expect(svc.decide(r.approval!.id, true, 'menubar', null)).rejects.toThrow('already declined')
    expect(tg.sent).toHaveLength(0)
  })

  test('recent sends, newest first, kept to the last 20', async () => {
    for (let i = 1; i <= 22; i++) await svc.call('s1', 'telegram_send_message', { to: 'leo', text: `m${i}` })
    const recent = svc.uiState().recent
    expect(recent).toHaveLength(20)
    expect(recent[0]!.text).toStartWith('m22')
    expect(recent[19]!.text).toStartWith('m3')
    expect(recent[0]).toMatchObject({ chatLabel: 'Leo Perera [leo]', via: 'auto', sessionLabel: 'one' })
  })
})

describe('first message to a new chat', () => {
  beforeEach(() => setup(baseConfig))
  const NEW = { id: 60, type: 'user' as const, name: 'Kasun Perera', username: 'kasun_p' }
  const saved = () => JSON.parse(readFileSync(path, 'utf8'))

  test('needs approval; "always allow" saves it and whitelists it', async () => {
    tg.add(NEW)
    const r = await svc.call('s1', 'telegram_send_message', { to: '@kasun_p', text: 'hi' })
    expect(r.approval).toMatchObject({ firstTime: true, nickname: null, suggestedNickname: 'kasun' })
    expect(r.text).toContain('First message to this chat')

    const ok = await svc.decide(r.approval!.id, true, 'menubar', null, { remember: 'autoSend' })
    expect(ok.text).toContain('Saved as "kasun" and whitelisted')
    expect(saved().chats.kasun).toMatchObject({ id: 60, username: 'kasun_p', name: 'Kasun Perera', type: 'user' })
    expect(saved().rules.autoSend).toContain('kasun')

    const next = await svc.call('s1', 'telegram_send_message', { to: 'kasun', text: 'again' })
    expect(next.approval).toBeUndefined()
    expect(tg.sent).toHaveLength(2)
  })

  test('"ask every time" saves it on requireApproval; later sends ask without the choice', async () => {
    tg.add(NEW)
    const r = await svc.call('s1', 'telegram_send_message', { to: '@kasun_p', text: 'hi' })
    await svc.decide(r.approval!.id, true, 'menubar', null, { remember: 'requireApproval', nickname: 'Kasun P' })
    expect(saved().chats['kasun p'].id).toBe(60)
    expect(saved().rules.requireApproval).toContain('kasun p')
    const next = await svc.call('s1', 'telegram_send_message', { to: 'kasun p', text: 'again' })
    expect(next.approval).toMatchObject({ firstTime: false })
  })

  test('no choice given defaults to ask every time; deny saves nothing', async () => {
    tg.add(NEW)
    const denied = await svc.call('s1', 'telegram_send_message', { to: '@kasun_p', text: 'x' })
    await svc.decide(denied.approval!.id, false, 'menubar', null, { remember: 'autoSend' })
    expect(saved().chats.kasun).toBeUndefined()
    expect(saved().rules.autoSend).not.toContain('kasun')

    const r = await svc.call('s1', 'telegram_send_message', { to: '@kasun_p', text: 'y' })
    await svc.call('s1', 'telegram_confirm_send', { approvalId: r.approval!.id })
    expect(saved().rules.requireApproval).toContain('kasun')
  })

  test('a session can never whitelist a chat by confirming in chat', async () => {
    tg.add(NEW)
    const r = await svc.call('s1', 'telegram_send_message', { to: '@kasun_p', text: 'y' })
    // An old client (or a talked-into-it model) still passing remember: it is ignored.
    const ok = await svc.call('s1', 'telegram_confirm_send', { approvalId: r.approval!.id, remember: 'autoSend' })
    expect(ok.isError).toBeFalsy()
    expect(tg.sent).toHaveLength(1)
    expect(saved().rules.autoSend).not.toContain('kasun')
    expect(saved().rules.requireApproval).toContain('kasun')
  })

  // The model cannot approve what the menu bar is asking the user.
  test('confirm_send is refused while the draft waits in the menu bar; the menu bar still decides', async () => {
    svc.touchUi()
    const r = await svc.call('s1', 'telegram_send_message', { to: 'qa', text: 'QA please' })
    expect(r.approval?.uiActive).toBe(true)
    expect(r.text).toContain('do not call telegram_confirm_send')

    const self = await svc.call('s1', 'telegram_confirm_send', { approvalId: r.approval!.id })
    expect(self.isError).toBe(true)
    expect(self.text).toContain('Only they can approve it')
    expect(tg.sent).toHaveLength(0)
    expect(svc.uiState().approvals).toHaveLength(1) // still waiting for the human

    await svc.decide(r.approval!.id, true, 'menubar', null)
    expect(tg.sent).toHaveLength(1)
  })

  test('a draft asked in chat cannot be confirmed once the menu bar comes up', async () => {
    const r = await svc.call('s1', 'telegram_send_message', { to: 'qa', text: 'x' })
    expect(r.approval?.uiActive).toBe(false)
    svc.touchUi()
    const self = await svc.call('s1', 'telegram_confirm_send', { approvalId: r.approval!.id })
    expect(self.isError).toBe(true)
    expect(tg.sent).toHaveLength(0)
  })

  test('the model may still cancel a draft the menu bar is showing', async () => {
    svc.touchUi()
    const r = await svc.call('s1', 'telegram_send_message', { to: 'qa', text: 'x' })
    const cancel = await svc.call('s1', 'telegram_cancel_send', { approvalId: r.approval!.id })
    expect(cancel.isError).toBeFalsy()
    expect(tg.sent).toHaveLength(0)
    expect(svc.uiState().approvals).toHaveLength(0)
  })

  test('a taken nickname falls back to a free one', async () => {
    tg.add({ id: 61, type: 'user', name: 'Leo Fernando', username: 'leo_f' })
    const r = await svc.call('s1', 'telegram_send_message', { to: '@leo_f', text: 'x' })
    expect(r.approval!.suggestedNickname).toBe('leo_f') // "leo" is taken
    const ok = await svc.decide(r.approval!.id, true, 'menubar', null, { remember: 'autoSend', nickname: 'leonardo' })
    expect(ok.text).toContain('"leonardo" was taken')
    expect(saved().chats.leo_f.id).toBe(61)
    expect(saved().chats.leonardo.id).toBe(LEONARDO.id)
  })

  test('an already saved chat keeps its nickname and just joins the list', async () => {
    const r = await svc.call('s1', 'telegram_send_message', { to: 'leonardo', text: 'x' })
    expect(r.approval).toMatchObject({ firstTime: true, nickname: 'leonardo' })
    await svc.decide(r.approval!.id, true, 'menubar', null, { remember: 'autoSend' })
    expect(saved().rules.autoSend).toContain('leonardo')
    expect(Object.keys(saved().chats).filter(k => saved().chats[k].id === LEONARDO.id)).toEqual(['leonardo'])
  })

  test('chats already on requireApproval are not "first time"', async () => {
    const r = await svc.call('s1', 'telegram_send_message', { to: 'qa', text: 'x' })
    expect(r.approval!.firstTime).toBe(false)
  })
})

describe('menu bar contacts', () => {
  beforeEach(() => setup(baseConfig))
  const onDisk = () => JSON.parse(readFileSync(path, 'utf8'))

  test('the state lists every saved chat with the rule that decides it', () => {
    const state = svc.uiState()
    expect(state.defaultPolicy).toBe('approve')
    const by = Object.fromEntries(state.contacts.map(c => [c.nickname, c]))
    expect(state.contacts.map(c => c.nickname)).toEqual(['allhands', 'anna', 'leo', 'leonardo', 'qa'])
    expect(by.leo).toMatchObject({ chatId: LEO.id, sendMode: 'autoSend', autoReply: true })
    expect(by.allhands).toMatchObject({ sendMode: 'blocked', autoReply: false })
    expect(by.qa).toMatchObject({ sendMode: 'requireApproval', autoReply: true, topicId: 42 })
    expect(by.leonardo).toMatchObject({ sendMode: 'none', policy: 'needs approval (default)' })
  })

  test('a sending rule change is saved and applies to the next send', async () => {
    const r = svc.editContact({ nickname: 'leo', sendMode: 'requireApproval' })
    expect(r).toMatchObject({ ok: true, nickname: 'leo' })
    expect(r.text).toContain('ask every time')
    expect(onDisk().rules.autoSend).toEqual(['allhands'])
    expect(onDisk().rules.requireApproval).toEqual(['qa', 'leo'])
    const send = await svc.call('s1', 'telegram_send_message', { to: 'leo', text: 'x' })
    expect(send.approval).toBeDefined()
    expect(tg.sent).toHaveLength(0)
  })

  test('auto-reply on and off decides who can be watched', async () => {
    expect(svc.editContact({ nickname: 'leonardo', autoReply: true }).ok).toBe(true)
    expect((await svc.call('s1', 'telegram_watch', { chat: 'leonardo' })).isError).toBeFalsy()
    expect(svc.editContact({ nickname: 'anna', autoReply: false }).text).toContain('auto-reply off')
    expect((await svc.call('s1', 'telegram_watch', { chat: 'anna' })).isError).toBe(true)
  })

  test('the reply text follows the sending rule that wins', () => {
    setup({ ...baseConfig, rules: { ...baseConfig.rules, autoReply: [] } })
    expect(svc.editContact({ nickname: 'qa', autoReply: true }).text).toBe(
      '"qa": auto-reply on: sessions may listen there, but their replies ask first (Ask every time wins).',
    )
    expect(svc.editContact({ nickname: 'qa', sendMode: 'blocked' }).text).toBe(
      `"qa": blocked: nothing is sent there; auto-reply on: sessions may listen there, but can't reply (blocked wins).`,
    )
    expect(svc.editContact({ nickname: 'qa', sendMode: 'autoSend' }).text).toBe('"qa": always allow: messages there send without asking.')
    expect(svc.editContact({ nickname: 'leonardo', rename: 'leo s' }).text).toBe('"leo s": renamed from "leonardo".')
  })

  test('renaming keeps the chat on its lists and frees the old name', async () => {
    const r = svc.editContact({ nickname: 'qa', rename: 'team-qa' })
    expect(r).toMatchObject({ ok: true, nickname: 'team-qa' })
    expect(r.text).toContain('renamed from "qa"')
    expect(onDisk().rules.requireApproval).toEqual(['team-qa'])
    expect(onDisk().rules.autoReply).toEqual(['anna', 'leo', 'team-qa'])
    expect((await svc.call('s1', 'telegram_send_message', { to: 'team-qa', text: 'x' })).approval).toBeDefined()
    expect((await svc.call('s1', 'telegram_send_message', { to: 'qa', text: 'x' })).isError).toBe(true)
  })

  test('no change writes nothing', () => {
    const text = readFileSync(path, 'utf8')
    expect(svc.editContact({ nickname: 'leo', sendMode: 'autoSend', autoReply: true, rename: 'leo' })).toMatchObject({
      ok: true,
      text: '"leo" already has that setting.',
    })
    expect(readFileSync(path, 'utf8')).toBe(text)
  })

  test('refusals leave the file alone', () => {
    const text = readFileSync(path, 'utf8')
    expect(svc.editContact({ nickname: 'nobody', sendMode: 'autoSend' })).toMatchObject({ ok: false, text: 'Not changed: No saved chat called "nobody".' })
    // Several changes are all-or-nothing: the bad rename also drops the sending change.
    const clash = svc.editContact({ nickname: 'anna', sendMode: 'blocked', rename: 'leo' })
    expect(clash.ok).toBe(false)
    expect(clash.text).toContain('already means leo')
    expect(readFileSync(path, 'utf8')).toBe(text)
  })

  test('a broken config.json is reported, not overwritten', () => {
    writeFileSync(path, '{ "rules": ')
    const r = svc.editContact({ nickname: 'leo', sendMode: 'blocked' })
    expect(r.ok).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('{ "rules": ')
  })
})

describe('paging from the Contacts page', () => {
  beforeEach(() => setup(baseConfig))
  const onDisk = () => JSON.parse(readFileSync(path, 'utf8'))

  test('"can page me" puts the person on paging.pageFrom by id', () => {
    const on = svc.editContact({ nickname: 'leo', pageFrom: true })
    expect(on).toMatchObject({ ok: true, text: '"leo": can page you: their "/page <reason>" rings your desktop.' })
    expect(onDisk().paging.pageFrom).toEqual([LEO.id])
    expect(svc.uiState().contacts.find(c => c.nickname === 'leo')).toMatchObject({ pageable: true, pageFrom: true })
    expect(svc.editContact({ nickname: 'leo', pageFrom: true }).text).toBe('"leo" already has that setting.')
    expect(svc.editContact({ nickname: 'leo', pageFrom: false }).text).toBe('"leo": can\'t page you.')
    expect(onDisk().paging.pageFrom).toEqual([])
  })

  test('a group can\'t be put on pageFrom', () => {
    const text = readFileSync(path, 'utf8')
    expect(svc.editContact({ nickname: 'qa', pageFrom: true })).toEqual({
      ok: false,
      text: 'Not changed: Only a person can page you, and "qa" is a group or channel.',
    })
    expect(readFileSync(path, 'utf8')).toBe(text)
  })

  test('the Page button sends "/page <reason>" as one line, without the footer, and logs it', async () => {
    const r = await svc.pageContact('leonardo', '  prod is down\n\nplease   look ')
    expect(r).toMatchObject({ ok: true })
    expect(r.text).toStartWith('Paged leonardo.')
    expect(tg.sent).toHaveLength(1)
    expect(tg.sent[0]).toMatchObject({ chatId: LEONARDO.id, text: '/page prod is down please look' })
    expect(svc.uiState().recent.at(-1)).toMatchObject({ chatId: LEONARDO.id, chatLabel: 'leonardo', via: 'menubar', sessionLabel: null })
  })

  test('no reason sends a bare /page', async () => {
    expect((await svc.pageContact('leo', '   ')).ok).toBe(true)
    expect(tg.sent[0]!.text).toBe('/page')
  })

  test('blocked chats, groups and unknown names are not paged', async () => {
    setup({ ...baseConfig, rules: { ...baseConfig.rules, blocked: ['anna'] } })
    expect(await svc.pageContact('anna', 'x')).toEqual({ ok: false, text: 'Not paged: "anna" is blocked (this chat is on the blocked list).' })
    expect((await svc.pageContact('qa', 'x')).text).toBe('Not paged: Only a person can be paged, and "qa" is a group or channel.')
    expect((await svc.pageContact('nobody', 'x')).text).toBe('Not paged: No saved chat called "nobody".')
    setup({ ...baseConfig, defaultPolicy: 'block' })
    expect((await svc.pageContact('leonardo', 'x')).ok).toBe(false) // on no list, and the default blocks
    expect(tg.sent).toHaveLength(0)
  })

  test('a contact whose username changed is not paged, and a block by the new @username applies', async () => {
    setup({ ...baseConfig, chats: { ...baseConfig.chats, anna: { id: ANNA.id, username: 'anna_old', name: ANNA.name } } })
    expect((await svc.pageContact('anna', 'x')).text).toContain('was @anna_old, but Telegram now says @anna_k')
    setup({ ...baseConfig, rules: { ...baseConfig.rules, blocked: ['@anna_k'] } })
    expect((await svc.pageContact('anna', 'x')).text).toBe('Not paged: "anna" is blocked (this chat is on the blocked list).')
    expect(tg.sent).toHaveLength(0)
  })

  test('a long reason is cut at a whole character', () => {
    const long = '🔥'.repeat(PAGE_REASON_MAX + 50)
    const cut = pageReason(long)
    expect(Array.from(cut)).toHaveLength(PAGE_REASON_MAX)
    expect(cut.endsWith('🔥…')).toBe(true)
    expect(pageReason('a\u202eb\u200fc')).toBe('a b c')
  })
})
