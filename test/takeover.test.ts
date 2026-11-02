import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Approvals } from '../src/daemon/approvals'
import { Service, describeMessage } from '../src/daemon/service'
import { SessionHub, formatEvent } from '../src/daemon/sessions'
import { ConfigStore } from '../src/shared/config'
import { decideSend } from '../src/shared/policy'
import { looksLikeReplyCommand, parseReplyCommand } from '../src/shared/takeover'
import { ANNA, FakeTelegram, LEO, TEAM_QA } from './fake-telegram'

describe('parsing /reply', () => {
  test('start, with and without an instruction', () => {
    expect(parseReplyCommand('/reply')).toEqual({ action: 'start', instruction: '' })
    expect(parseReplyCommand('  /reply  say I am on my way ')).toEqual({ action: 'start', instruction: 'say I am on my way' })
    expect(parseReplyCommand('/reply@somebot hi')).toEqual({ action: 'start', instruction: 'hi' })
    expect(parseReplyCommand('/REPLY\nline two')).toEqual({ action: 'start', instruction: 'line two' })
  })

  test('stop words', () => {
    for (const w of ['stop', 'off', 'END', 'done']) expect(parseReplyCommand(`/reply ${w}`)).toEqual({ action: 'stop' })
  })

  test('not commands', () => {
    for (const t of ['reply', 'please /reply', '/replyall', '/replies', '']) expect(parseReplyCommand(t)).toBeNull()
  })

  test('the send guard', () => {
    expect(looksLikeReplyCommand('  /reply hi')).toBe(true)
    expect(looksLikeReplyCommand('use /reply to hand me a chat')).toBe(false)
  })
})

describe('policy', () => {
  const config = { chats: {}, rules: { blocked: [ANNA.id], requireApproval: [LEO.id], autoSend: [], autoReply: [] }, defaultPolicy: 'approve', footer: '', guides: [] } as never
  test('a takeover sends without asking, even on requireApproval', () => {
    expect(decideSend(config, { id: LEO.id }, { isWatching: false, takenOver: true }).action).toBe('send')
  })
  test('blocked still wins', () => {
    expect(decideSend(config, { id: ANNA.id }, { isWatching: false, takenOver: true }).action).toBe('block')
  })
  test('a file during a takeover still asks', () => {
    expect(decideSend(config, { id: TEAM_QA.id }, { isWatching: false, takenOver: true, file: true }).action).toBe('approve')
  })
})

describe('takeover', () => {
  function setup(rules: object = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'tgmcp-'))
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({ footer: '', chats: { anna: { id: ANNA.id, username: 'anna_k', name: ANNA.name } }, rules }))
    const tg = new FakeTelegram().add(LEO, ANNA, TEAM_QA)
    const hub = new SessionHub()
    const store = new ConfigStore(path)
    const svc = new Service({ store, tg, hub, approvals: new Approvals(), eventsUrl: () => 'ws://x', takeoverMinutes: 30 })
    const frames: string[] = []
    hub.attachProxy('s1', { label: 'one', channel: false, watches: [] }, { send() {} })
    hub.attachMonitor('s1', { send: (f: string) => frames.push(f) })
    // Like the daemon: own messages are commands, the rest go to takeovers and watches.
    tg.onMessage(m => {
      if (m.outgoing) void svc.handleOwnMessage(m)
      else hub.dispatch(m, x => describeMessage(store, x))
    })
    return { tg, hub, svc, frames }
  }
  const mine = (tg: FakeTelegram, chatId: number, text: string) => tg.emit(chatId, text, 1, { outgoing: true, from: tg.me })
  const flush = () => new Promise(r => setTimeout(r, 0))

  test('/reply hands the chat to the answering session, deletes the command and lets replies through', async () => {
    const { tg, hub, svc, frames } = setup()
    await svc.call('s1', 'telegram_answer_reply', {})
    const cmd = mine(tg, ANNA.id, '/reply tell her I will call at 6')
    await flush()
    expect(hub.takeoverOf(ANNA.id)).toBe('s1')
    expect(tg.deleted).toEqual([{ chatId: ANNA.id, messageId: cmd.id }])
    expect(frames.at(-1)).toContain('Takeover: the user typed /reply')
    expect(frames.at(-1)).toContain('tell her I will call at 6')
    // Anna is in no list, so normally this would ask first.
    const r = await svc.call('s1', 'telegram_send_message', { to: 'anna', text: 'I will call you at 6' })
    expect(r.approval).toBeUndefined()
    expect(tg.sent).toHaveLength(1)
    // Her next message comes to the session even though she is not on autoReply.
    tg.emit(ANNA.id, 'ok thanks')
    expect(frames.at(-1)).toContain('ok thanks')
    expect(frames.at(-1)).toContain('watch takeover')
  })

  test('/reply stop takes it back', async () => {
    const { tg, hub, svc, frames } = setup()
    await svc.call('s1', 'telegram_answer_reply', {})
    mine(tg, ANNA.id, '/reply')
    await flush()
    mine(tg, ANNA.id, '/reply stop')
    await flush()
    expect(hub.takeoverOf(ANNA.id)).toBeNull()
    expect(frames.at(-1)).toContain('Takeover ended')
    const r = await svc.call('s1', 'telegram_send_message', { to: 'anna', text: 'hi' })
    expect(r.approval).toBeDefined()
  })

  test('nobody answering: nothing is taken over and the command stays visible', async () => {
    const { tg, hub } = setup()
    mine(tg, ANNA.id, '/reply')
    await flush()
    expect(hub.takeoverOf(ANNA.id)).toBeNull()
    expect(tg.deleted).toHaveLength(0)
  })

  test('only your own messages count', async () => {
    const { tg, hub, svc } = setup()
    await svc.call('s1', 'telegram_answer_reply', {})
    tg.emit(ANNA.id, '/reply')
    await flush()
    expect(hub.takeoverOf(ANNA.id)).toBeNull()
  })

  test('a blocked chat is never taken over', async () => {
    const { tg, hub, svc } = setup({ blocked: [ANNA.id] })
    await svc.call('s1', 'telegram_answer_reply', {})
    mine(tg, ANNA.id, '/reply')
    await flush()
    expect(hub.takeoverOf(ANNA.id)).toBeNull()
    expect(tg.deleted).toHaveLength(0)
  })

  test('a takeover expires', async () => {
    let now = 1_000
    const hub = new SessionHub({ now: () => now })
    hub.attachProxy('s1', { label: 'one', channel: false, watches: [] }, { send() {} })
    hub.attachMonitor('s1', { send() {} })
    hub.setReplyHandler('s1', true)
    const base = { chatId: ANNA.id, chatLabel: 'Anna', fromId: 1, fromName: 'me', fromUsername: null, messageId: 1, topicId: null, replyToId: null, text: '', media: null, date: '' }
    expect(hub.startTakeover(ANNA.id, 60_000, base)).toBe('s1')
    now += 61_000
    expect(hub.takeoverOf(ANNA.id)).toBeNull()
  })

  test('Claude may not send a message that starts with /reply', async () => {
    const { tg, svc } = setup({ autoSend: ['anna'] })
    const r = await svc.call('s1', 'telegram_send_message', { to: 'anna', text: '/reply stop' })
    expect(r.isError).toBe(true)
    expect(tg.sent).toHaveLength(0)
  })

  test('the notice reads as a takeover, not a chat message', () => {
    const text = formatEvent({
      seq: 1, watchIds: ['takeover'], chatId: 5, chatLabel: 'Anna', fromId: 1, fromName: 'me', fromUsername: null,
      messageId: 9, topicId: null, replyToId: null, text: '/reply', media: null, date: '',
      takeover: { action: 'start', instruction: '', minutes: 30 },
    })
    expect(text).toContain('No instruction')
    expect(text).toContain('30 minutes')
  })
})
