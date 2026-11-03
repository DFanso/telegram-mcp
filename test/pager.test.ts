import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Approvals } from '../src/daemon/approvals'
import { PageBot, actionButtons, parseButton } from '../src/daemon/page-bot'
import { Pager, cleanReason, hasKeyword, pageTrigger, type Page, type PageChannel } from '../src/daemon/pager'
import { readDaemonReply } from '../src/shared/daemon-reply'
import { Service } from '../src/daemon/service'
import { SessionHub } from '../src/daemon/sessions'
import { ConfigStore, parseConfig } from '../src/shared/config'
import type { IncomingMessage, PeerInfo } from '../src/shared/protocol'
import { ANNA, FakeTelegram, LEO, TEAM_QA } from './fake-telegram'

const msg = (chat: PeerInfo, text: string, from: PeerInfo | null = chat, extra: Partial<IncomingMessage> = {}): IncomingMessage => ({
  id: 7,
  chatId: chat.id,
  chat,
  date: '',
  from,
  outgoing: false,
  text,
  media: null,
  replyToId: null,
  topicId: null,
  ...extra,
})

describe('what pages', () => {
  const config = parseConfig(
    JSON.stringify({
      chats: { qa: { id: TEAM_QA.id, name: TEAM_QA.name } },
      paging: { pageFrom: [ANNA.id], vip: ['qa'] },
    }),
  )

  test('/page from someone on pageFrom', () => {
    expect(pageTrigger(config, msg(ANNA, '/page prod is down, call me'))).toEqual({ source: 'command', reason: 'prod is down, call me' })
    expect(pageTrigger(config, msg(ANNA, '/page'))).toEqual({ source: 'command', reason: '' })
  })

  test('/page from anyone else, or from yourself, pages no one', () => {
    expect(pageTrigger(config, msg(LEO, '/page now'))).toBeNull()
    expect(pageTrigger(config, msg(ANNA, '/page now', ANNA, { outgoing: true }))).toBeNull()
  })

  test('keywords only in VIP chats, and only as whole words', () => {
    expect(pageTrigger(config, msg(TEAM_QA, 'KYC is DOWN again', LEO))).toEqual({ source: 'keyword', reason: 'KYC is DOWN again' })
    expect(pageTrigger(config, msg(TEAM_QA, 'downstream service ok', LEO))).toBeNull()
    expect(pageTrigger(config, msg(TEAM_QA, 'products page fine', LEO))).toBeNull()
    expect(pageTrigger(config, msg(ANNA, 'urgent!!'))).toBeNull()
  })

  test('the reason is plain, bounded text', () => {
    expect(cleanReason('  hi\u0007 ‮there ')).toBe('hi there')
    expect(cleanReason('x'.repeat(400))).toHaveLength(300)
  })
})

class FakeChannel implements PageChannel {
  sent: { pageId: string; text: string }[] = []
  settled: { id: number; text: string }[] = []
  fail = false
  async send(page: Page, text: string) {
    if (this.fail) throw new Error('403: bot was blocked by the user')
    this.sent.push({ pageId: page.id, text })
    return 100 + this.sent.length
  }
  async settle(id: number, text: string) {
    this.settled.push({ id, text })
  }
}

function setup(o: { channel?: boolean } = {}) {
  let now = 1_000_000
  const told: { chatId: number; text: string; replyTo: number | null }[] = []
  const channel = new FakeChannel()
  const dir = mkdtempSync(join(tmpdir(), 'tgmcp-pages-'))
  const pager = new Pager({
    paging: () => ({ pageFrom: [], vip: [], keywords: [], retryMinutes: 5, tries: 3, perSenderMinutes: 10 }),
    ownerName: () => 'Leo',
    channel: () => (o.channel === false ? null : channel),
    tellSender: async (chatId, text, replyTo) => void told.push({ chatId, text, replyTo }),
    auditPath: join(dir, 'pages.jsonl'),
    now: () => now,
  })
  const fromAnna = {
    source: 'command' as const,
    senderKey: String(ANNA.id),
    senderName: 'Anna',
    chatId: ANNA.id,
    chatLabel: 'Anna',
    messageId: 42,
    reason: 'prod is down',
  }
  return { pager, channel, told, fromAnna, audit: () => readFileSync(join(dir, 'pages.jsonl'), 'utf8'), advance: (ms: number) => (now += ms) }
}

describe('a page', () => {
  test('tells the sender, rings, and reaches the phone at once', async () => {
    const { pager, channel, told, fromAnna } = setup()
    const r = await pager.page(fromAnna)
    expect(r.ok).toBe(true)
    expect(told).toEqual([{ chatId: ANNA.id, text: "Paging Leo now. I'll tell you when they've seen it.", replyTo: 42 }])
    expect(pager.ringing()).toBe(true)
    expect(channel.sent).toHaveLength(1)
    expect(channel.sent[0]!.text).toContain('📟 PAGE from Anna')
    expect(channel.sent[0]!.text).toContain('prod is down')
    expect(channel.sent[0]!.text).toContain('Try 1 of 3')
  })

  test('one page per sender per window', async () => {
    const { pager, fromAnna, advance } = setup()
    await pager.page(fromAnna)
    const again = await pager.page(fromAnna)
    expect(again.ok).toBe(false)
    advance(10 * 60_000)
    expect((await pager.page(fromAnna)).ok).toBe(true)
  })

  test('retries on the phone, then tells the sender and keeps ringing', async () => {
    const { pager, channel, told, fromAnna, advance } = setup()
    await pager.page(fromAnna)
    await pager.tick()
    expect(channel.sent).toHaveLength(1)
    advance(5 * 60_000)
    await pager.tick()
    advance(5 * 60_000)
    await pager.tick()
    expect(channel.sent.map(s => s.text.split('\n').at(-1))).toEqual(['Try 1 of 3', 'Try 2 of 3', 'Try 3 of 3'])
    advance(5 * 60_000)
    await pager.tick()
    expect(channel.sent).toHaveLength(3)
    expect(told.at(-1)!.text).toBe("Leo hasn't seen it yet. Try calling.")
    expect(pager.active()[0]!.state).toBe('unanswered')
    expect(pager.ringing()).toBe(true)
  })

  test('an ack anywhere settles every phone message and tells the sender', async () => {
    const { pager, channel, told, fromAnna, advance, audit } = setup()
    const r = await pager.page(fromAnna)
    advance(5 * 60_000)
    await pager.tick()
    const id = r.ok ? r.page.id : ''
    expect(await pager.act(id, { kind: 'ack' }, 'menubar')).toBe(true)
    expect(channel.settled.map(s => s.id)).toEqual([101, 102])
    expect(told.at(-1)!.text).toBe('Leo saw it.')
    expect(pager.ringing()).toBe(false)
    expect(pager.active()).toHaveLength(0)
    // Settled once; a second press (the phone, a moment later) does nothing.
    expect(await pager.act(id, { kind: 'ack' }, 'phone')).toBe(false)
    expect(audit()).toContain('"event":"ack"')
    expect(audit()).not.toContain('prod is down')
  })

  test('snooze goes quiet, then rings again', async () => {
    const { pager, channel, fromAnna, advance } = setup()
    const r = await pager.page(fromAnna)
    const id = r.ok ? r.page.id : ''
    await pager.act(id, { kind: 'snooze', minutes: 15 }, 'phone')
    expect(pager.ringing()).toBe(false)
    expect(pager.active()[0]!.state).toBe('snoozed')
    advance(14 * 60_000)
    await pager.tick()
    expect(pager.ringing()).toBe(false)
    advance(60_000)
    await pager.tick()
    expect(pager.ringing()).toBe(true)
    expect(channel.sent.at(-1)!.text).toContain('Try 1 of 3')
  })

  test('a page from Claude tells no chat anything', async () => {
    const { pager, told } = setup()
    await pager.page({ source: 'claude', senderKey: 'claude', senderName: 'kyc', chatId: ANNA.id, chatLabel: 'Anna', messageId: 3, reason: 'x' })
    expect(told).toHaveLength(0)
  })

  test('without a bot it still rings the desktop', async () => {
    const { pager, fromAnna } = setup({ channel: false })
    const r = await pager.page(fromAnna)
    expect(r.ok && r.page.botMessages).toEqual([])
    expect(pager.ringing()).toBe(true)
  })

  test('a phone that cannot be reached still counts the try', async () => {
    const { pager, channel, fromAnna } = setup()
    channel.fail = true
    const r = await pager.page(fromAnna)
    expect(r.ok && r.page.tries).toBe(1)
  })

  test('test pages skip the rate limit', async () => {
    const { pager } = setup()
    const t = { source: 'test' as const, senderKey: 'test', senderName: 'test', chatId: null, chatLabel: null, messageId: null, reason: '' }
    expect((await pager.page(t)).ok).toBe(true)
    expect((await pager.page(t)).ok).toBe(true)
  })
})

describe('the pager bot', () => {
  test('buttons round-trip, and nothing else parses', () => {
    const data = actionButtons('pg_abc1').inline_keyboard[0]!.map(b => b.callback_data)
    expect(data.map(parseButton)).toEqual([
      { pageId: 'pg_abc1', action: { kind: 'ack' } },
      { pageId: 'pg_abc1', action: { kind: 'snooze', minutes: 15 } },
      { pageId: 'pg_abc1', action: { kind: 'snooze', minutes: 60 } },
    ])
    expect(parseButton('ack:../etc')).toBeNull()
    expect(parseButton('run:pg_abc1')).toBeNull()
  })

  /** A Bot API that answers getUpdates once with `presses`, then waits to be aborted. */
  function fakeApi(presses: { from: number; data: string }[]) {
    const calls: { method: string; body: Record<string, unknown> }[] = []
    let served = false
    const f = async (url: string, init?: RequestInit) => {
      const method = url.split('/').at(-1)!
      const body = JSON.parse(String(init?.body ?? '{}'))
      calls.push({ method, body })
      if (method === 'getUpdates') {
        if (!served) {
          served = true
          const result = presses.map((p, i) => ({ update_id: i + 1, callback_query: { id: `q${i}`, from: { id: p.from }, data: p.data } }))
          return Response.json({ ok: true, result })
        }
        await new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
      }
      if (method === 'sendMessage') return Response.json({ ok: true, result: { message_id: 9 } })
      return Response.json({ ok: true, result: true })
    }
    return { f, calls }
  }

  test('sends to the owner only, and only the owner can press', async () => {
    const actions: string[] = []
    const { f, calls } = fakeApi([
      { from: 666, data: 'ack:pg_x1' },
      { from: LEO.id, data: 's60:pg_x1' },
    ])
    const bot = new PageBot({ token: '1:x', ownerId: () => LEO.id, onAction: (id, a) => void actions.push(`${id} ${JSON.stringify(a)}`), fetch: f })
    const page = { id: 'pg_x1' } as Page
    expect(await bot.send(page, 'hello')).toBe(9)
    const sent = calls.find(c => c.method === 'sendMessage')!
    expect(sent.body.chat_id).toBe(LEO.id)
    expect(sent.body.parse_mode).toBeUndefined()
    bot.start()
    await new Promise(r => setTimeout(r, 20))
    bot.stop()
    expect(actions).toEqual(['pg_x1 {"kind":"snooze","minutes":60}'])
    expect(calls.filter(c => c.method === 'answerCallbackQuery').map(c => c.body.text)).toEqual(['This pager is not yours.', 'Got it.'])
  })

  test('no owner yet: nothing is sent', async () => {
    const { f } = fakeApi([])
    const bot = new PageBot({ token: '1:x', ownerId: () => null, onAction: () => {}, fetch: f })
    await expect(bot.send({ id: 'pg_1' } as Page, 'x')).rejects.toThrow('not connected')
  })
})

describe('telegram_page and the menu bar', () => {
  function serviceSetup() {
    const dir = mkdtempSync(join(tmpdir(), 'tgmcp-'))
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({ footer: '', chats: { anna: { id: ANNA.id, username: 'anna_k', name: ANNA.name } }, rules: {} }))
    const tg = new FakeTelegram().add(LEO, ANNA)
    const hub = new SessionHub()
    const store = new ConfigStore(path)
    const pager = new Pager({
      paging: () => store.get().paging,
      ownerName: () => 'Leo',
      channel: () => null,
      tellSender: async () => {},
    })
    const svc = new Service({ store, tg, hub, approvals: new Approvals(), eventsUrl: () => 'ws://x', pager })
    hub.attachProxy('s1', { label: 'kyc', channel: false, watches: [] }, { send() {} })
    return { svc, pager }
  }

  test('Claude pages once, then waits', async () => {
    const { svc } = serviceSetup()
    const r = await svc.call('s1', 'telegram_page', { reason: 'KYC prod 500s', chat: 'anna', messageId: 5 })
    expect(r.isError).toBeUndefined()
    expect(r.text).toContain('Paged the user')
    const page = svc.uiState().pages[0]!
    expect(page).toMatchObject({ source: 'claude', state: 'ringing', from: 'Claude (kyc)', chat: 'Anna K [anna]', reason: 'KYC prod 500s' })
    const again = await svc.call('s1', 'telegram_page', { reason: 'still down' })
    expect(again.isError).toBe(true)
  })

  test('the menu bar acks and snoozes', async () => {
    const { svc } = serviceSetup()
    await svc.call('s1', 'telegram_page', { reason: 'x' })
    const id = svc.uiState().pages[0]!.id
    expect(await svc.pageAction(id, { kind: 'snooze', minutes: 60 }, 'menubar')).toBe(true)
    expect(svc.uiState().pages[0]!.state).toBe('snoozed')
    expect(svc.uiState().pages[0]!.snoozedUntil).not.toBeNull()
    expect(await svc.pageAction(id, { kind: 'ack' }, 'tray')).toBe(true)
    expect(svc.uiState().pages).toHaveLength(0)
  })

  test('tgmcp page test rings', async () => {
    const { svc } = serviceSetup()
    const r = await svc.testPage()
    expect(r.ok).toBe(true)
    expect(svc.uiState().pages[0]!.source).toBe('test')
  })
})

describe('the daemon', () => {
  async function daemonWith(rules: object) {
    const { createDaemon } = await import('../src/daemon/main')
    const { getPaths } = await import('../src/shared/paths')
    const paths = getPaths(mkdtempSync(join(tmpdir(), 'tgmcp-page-')))
    writeFileSync(paths.config, JSON.stringify({ footer: '', paging: { pageFrom: [ANNA.id] }, rules }))
    const tg = new FakeTelegram().add(LEO, ANNA)
    const daemon = await createDaemon({ paths, port: 0, telegram: tg, log: () => {}, pageBotToken: null })
    return { tg, daemon, paths }
  }
  const settle = () => new Promise(r => setTimeout(r, 20))

  test('/page from someone on pageFrom rings and answers them', async () => {
    const { tg, daemon, paths } = await daemonWith({})
    tg.emit(ANNA.id, '/page KYC prod down')
    await settle()
    expect(daemon.pager.active().map(p => p.reason)).toEqual(['KYC prod down'])
    expect(tg.sent.map(s => [s.chatId, s.text])).toEqual([[ANNA.id, "Paging Me now. I'll tell you when they've seen it."]])
    expect(readFileSync(paths.pages, 'utf8')).toContain('"event":"page"')
    // Anyone else's /page does nothing.
    tg.emit(LEO.id, '/page hello')
    await settle()
    expect(daemon.pager.active()).toHaveLength(1)
    await daemon.stop()
  })

  test('a blocked chat still pages, but hears nothing back', async () => {
    const { tg, daemon } = await daemonWith({ blocked: [ANNA.id] })
    tg.emit(ANNA.id, '/page help')
    await settle()
    expect(daemon.pager.active()).toHaveLength(1)
    expect(tg.sent).toHaveLength(0)
    await daemon.stop()
  })
})

describe('review follow-ups: what pages', () => {
  const config = parseConfig(
    JSON.stringify({
      chats: { qa: { id: TEAM_QA.id, name: TEAM_QA.name } },
      paging: { pageFrom: [ANNA.id], vip: ['qa'] },
    }),
  )
  const kw = ['urgent', 'down', 'prod', 'asap']

  test('keywords inside hyphenated words, hosts, paths and identifiers do not page', () => {
    for (const text of ['this is non-urgent', 'deployed to pre-prod', 'see prod.example.com', 'prod_db is fine', 'check /prod/logs', 'mail ops@prod', 'prod-like env']) {
      expect([text, hasKeyword(text, kw)]).toEqual([text, false])
    }
  })

  test('keywords as words of their own still page, punctuation and all', () => {
    for (const text of ['prod is down.', 'URGENT: kyc', 'is it prod?', 'its down!', '(urgent)', 'need this asap', 'නැවතත් down']) {
      expect([text, hasKeyword(text, kw)]).toEqual([text, true])
    }
  })

  test('/page from someone not on pageFrom is an ordinary message: keywords in a VIP chat still page', () => {
    expect(pageTrigger(config, msg(TEAM_QA, '/page prod is down', LEO))).toEqual({ source: 'keyword', reason: '/page prod is down' })
    expect(pageTrigger(config, msg(TEAM_QA, '/page hello', LEO))).toBeNull()
    // Outside a VIP chat it is still nothing.
    expect(pageTrigger(config, msg(LEO, '/page prod is down'))).toBeNull()
  })

  test('the reason is one line, has no direction marks, and is cut on whole characters', () => {
    expect(cleanReason('prod\n\n  is\tdown\r\nnow')).toBe('prod is down now')
    expect(cleanReason('a\u200eb\u200fc\u061cd')).toBe('abcd')
    const emoji = cleanReason(`${'x'.repeat(298)}😀😀😀`)
    expect(Array.from(emoji)).toHaveLength(300)
    expect(emoji.endsWith('😀…')).toBe(true)
    // No half an emoji (a lone surrogate) at the cut.
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji)).toBe(false)
    expect(cleanReason(`${'x'.repeat(298)}😀😀`)).toBe(`${'x'.repeat(298)}😀😀`)
  })
})

/** A channel whose sends wait until release(), to act while a push is on its way. */
class SlowChannel extends FakeChannel {
  #waiting: (() => void)[] = []
  override async send(page: Page, text: string) {
    await new Promise<void>(r => this.#waiting.push(r))
    return super.send(page, text)
  }
  release() {
    for (const r of this.#waiting.splice(0)) r()
  }
  get pending() {
    return this.#waiting.length
  }
}

describe('review follow-ups: a page', () => {
  test('a snooze tells the sender it was seen, once; no "hasn\'t seen it" after that', async () => {
    const { pager, told, fromAnna, advance } = setup()
    const r = await pager.page(fromAnna)
    const id = r.ok ? r.page.id : ''
    await pager.act(id, { kind: 'snooze', minutes: 15 }, 'phone')
    expect(told.map(t => t.text)).toEqual(["Paging Leo now. I'll tell you when they've seen it.", 'Leo saw it.'])
    // Rings again after the snooze and runs out of tries: the sender already knows it was seen.
    for (let i = 0; i < 5; i++) {
      advance(15 * 60_000)
      await pager.tick()
    }
    expect(pager.active()[0]!.state).toBe('unanswered')
    await pager.act(id, { kind: 'ack' }, 'menubar')
    expect(told.map(t => t.text)).toEqual(["Paging Leo now. I'll tell you when they've seen it.", 'Leo saw it.'])
  })

  test('a tick while the first push is on its way does not push again', async () => {
    const { pager, fromAnna, advance } = setup()
    const channel = new SlowChannel()
    ;(pager as unknown as { d: { channel: () => PageChannel } }).d.channel = () => channel
    const paging = pager.page(fromAnna)
    await Bun.sleep(1)
    advance(10 * 60_000)
    await pager.tick()
    await pager.tick()
    expect(channel.pending).toBe(1)
    channel.release()
    const r = await paging
    expect(r.ok && r.page.tries).toBe(1)
    expect(channel.sent).toHaveLength(1)
  })

  test('acked while the push was on its way: that push is settled too', async () => {
    const { pager, fromAnna } = setup()
    const channel = new SlowChannel()
    ;(pager as unknown as { d: { channel: () => PageChannel } }).d.channel = () => channel
    const paging = pager.page(fromAnna)
    await Bun.sleep(1)
    const id = pager.active()[0]!.id
    expect(await pager.act(id, { kind: 'ack' }, 'menubar')).toBe(true)
    channel.release()
    await paging
    expect(channel.settled).toEqual([{ id: 101, text: '✅ Acked from the menubar.' }])
  })

  test('acked before the first push went out: no push at all', async () => {
    let pager!: Pager
    const channel = new FakeChannel()
    pager = new Pager({
      paging: () => ({ pageFrom: [], vip: [], keywords: [], retryMinutes: 5, tries: 3, perSenderMinutes: 10 }),
      ownerName: () => 'Leo',
      channel: () => channel,
      // The desk acks while "Paging Leo now" is still being sent.
      tellSender: async (_c, text) => {
        if (text.startsWith('Paging')) await pager.act(pager.active()[0]!.id, { kind: 'ack' }, 'menubar')
      },
    })
    await pager.page({ source: 'command', senderKey: '12', senderName: 'Anna', chatId: ANNA.id, chatLabel: 'Anna', messageId: 1, reason: 'x' })
    expect(channel.sent).toHaveLength(0)
  })

  test('a rate-limited sender hears why, once per window; an ack lets them page again', async () => {
    const { pager, told, fromAnna, advance } = setup()
    const r = await pager.page(fromAnna)
    told.length = 0
    expect((await pager.page(fromAnna)).ok).toBe(false)
    expect((await pager.page(fromAnna)).ok).toBe(false)
    expect(told).toEqual([{ chatId: ANNA.id, text: 'Already paged Leo in the last 10 min. Try again in 10 min.', replyTo: 42 }])
    advance(60_000)
    await pager.act(r.ok ? r.page.id : '', { kind: 'ack' }, 'phone')
    expect((await pager.page(fromAnna)).ok).toBe(true)
  })

  test('Claude being rate-limited tells no chat anything', async () => {
    const { pager, told } = setup()
    const claude = { source: 'claude' as const, senderKey: 'claude', senderName: 'kyc', chatId: ANNA.id, chatLabel: 'Anna', messageId: 3, reason: 'x' }
    await pager.page(claude)
    expect((await pager.page(claude)).ok).toBe(false)
    expect(told).toHaveLength(0)
  })

  test('a failed push is marked, so the status can say the bot is set up but could not reach the phone', async () => {
    const { pager, channel, fromAnna } = setup()
    channel.fail = true
    const r = await pager.page(fromAnna)
    expect(r.ok && r.page.deliveryFailed).toBe(true)
    expect(pager.hasChannel()).toBe(true)
    expect(setup({ channel: false }).pager.hasChannel()).toBe(false)
  })
})

describe('review follow-ups: the pager bot', () => {
  function api() {
    const calls: { method: string; body: Record<string, unknown> }[] = []
    const f = async (url: string, init?: RequestInit) => {
      const method = url.split('/').at(-1)!
      calls.push({ method, body: JSON.parse(String(init?.body ?? '{}')) })
      if (method === 'sendMessage') return Response.json({ ok: true, result: { message_id: 9 } })
      return Response.json({ ok: true, result: true })
    }
    return { f, calls }
  }

  test('settling edits the page message in place, so the phone does not buzz again', async () => {
    const { f, calls } = api()
    const bot = new PageBot({ token: '1:x', ownerId: () => LEO.id, onAction: () => {}, fetch: f })
    await bot.send({ id: 'pg_1' } as Page, '📟 PAGE from Anna')
    calls.length = 0
    await bot.settle(9, '✅ Acked from the menubar.')
    expect(calls).toEqual([
      {
        method: 'editMessageText',
        body: { chat_id: LEO.id, message_id: 9, text: '📟 PAGE from Anna\n\n✅ Acked from the menubar.', reply_markup: { inline_keyboard: [] } },
      },
    ])
  })

  test('a message it does not remember only loses its buttons', async () => {
    const { f, calls } = api()
    const bot = new PageBot({ token: '1:x', ownerId: () => LEO.id, onAction: () => {}, fetch: f })
    await bot.settle(77, 'x')
    expect(calls.map(c => c.method)).toEqual(['editMessageReplyMarkup'])
  })

  test('a Bot API call that hangs gives up', async () => {
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))
    const bot = new PageBot({ token: '1:x', ownerId: () => LEO.id, onAction: () => {}, fetch: hang, timeoutMs: 30 })
    const started = Date.now()
    await expect(bot.send({ id: 'pg_1' } as Page, 'x')).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe('review follow-ups: telegram_page and page test', () => {
  function serviceWith(channel: PageChannel | null) {
    const dir = mkdtempSync(join(tmpdir(), 'tgmcp-'))
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({ footer: '', chats: { anna: { id: ANNA.id, username: 'anna_k', name: ANNA.name } }, rules: {} }))
    const tg = new FakeTelegram().add(LEO, ANNA)
    const hub = new SessionHub()
    const store = new ConfigStore(path)
    const pager = new Pager({ paging: () => store.get().paging, ownerName: () => 'Leo', channel: () => channel, tellSender: async () => {} })
    const svc = new Service({ store, tg, hub, approvals: new Approvals(), eventsUrl: () => 'ws://x', pager })
    hub.attachProxy('s1', { label: 'kyc', channel: false, watches: [] }, { send() {} })
    return { svc }
  }

  test('a chat that does not resolve still pages, labelled as given', async () => {
    const { svc } = serviceWith(null)
    const r = await svc.call('s1', 'telegram_page', { reason: 'prod down', chat: 'nobody-saved' })
    expect(r.isError).toBeUndefined()
    expect(svc.uiState().pages[0]).toMatchObject({ chat: 'nobody-saved (not a saved chat)', chatId: null })
  })

  test('the answer says what really rang', async () => {
    const none = serviceWith(null).svc
    expect((await none.call('s1', 'telegram_page', { reason: 'x' })).text).toContain(
      'no menu bar or tray app is running, so nothing rings on the desktop; no pager bot is set up',
    )
    const failing = new FakeChannel()
    failing.fail = true
    const broken = serviceWith(failing).svc
    broken.touchUi()
    expect((await broken.call('s1', 'telegram_page', { reason: 'x' })).text).toContain(
      'the desktop rings until it is acked; the pager bot could not reach the phone',
    )
    const ok = serviceWith(new FakeChannel()).svc
    expect((await ok.testPage()).text).toContain('the phone got a push')
  })

  test('tgmcp page test can always print what the daemon said', async () => {
    expect(await readDaemonReply(new Response('unauthorized', { status: 401 }))).toEqual({
      ok: false,
      text: 'The daemon answered 401 (the daemon did not accept the token; try tgmcp restart): unauthorized',
    })
    expect((await readDaemonReply(new Response('Not Found', { status: 404 }))).text).toContain('no pager yet')
    expect(await readDaemonReply(Response.json({ ok: false, text: 'Paging is not available' }, { status: 409 }))).toEqual({ ok: false, text: 'Paging is not available' })
    expect(await readDaemonReply(Response.json({ ok: true, text: 'Test page pg_1' }))).toEqual({ ok: true, text: 'Test page pg_1' })
  })
})

describe('review follow-ups: the daemon', () => {
  async function daemonWith(config: object) {
    const { createDaemon } = await import('../src/daemon/main')
    const { getPaths } = await import('../src/shared/paths')
    const paths = getPaths(mkdtempSync(join(tmpdir(), 'tgmcp-page-')))
    writeFileSync(paths.config, JSON.stringify({ footer: '', paging: { pageFrom: [ANNA.id] }, ...config }))
    const tg = new FakeTelegram().add(LEO, ANNA)
    const daemon = await createDaemon({ paths, port: 0, telegram: tg, log: () => {}, pageBotToken: null })
    return { tg, daemon }
  }
  const settle = () => new Promise(r => setTimeout(r, 20))

  test('the fixed replies carry the footer and show under Recent', async () => {
    const { tg, daemon } = await daemonWith({ footer: '\n\n— bot' })
    tg.emit(ANNA.id, '/page KYC down')
    await settle()
    expect(tg.sent.map(s => s.text)).toEqual(["Paging Me now. I'll tell you when they've seen it.\n\n— bot"])
    expect(daemon.service.uiState().recent.map(r => [r.chatLabel, r.sessionLabel])).toEqual([['Anna K', 'pager']])
    await daemon.stop()
  })

  test('a chat blocked by its @username, or on requireApproval, still pages but hears nothing', async () => {
    for (const rules of [{ blocked: ['@anna_k'] }, { requireApproval: [ANNA.id] }]) {
      const { tg, daemon } = await daemonWith({ rules })
      tg.emit(ANNA.id, '/page help')
      await settle()
      expect(daemon.pager.active()).toHaveLength(1)
      expect(tg.sent).toHaveLength(0)
      await daemon.stop()
    }
  })

  test('an old /page (the catch-up after a restart) pages no one', async () => {
    const { tg, daemon } = await daemonWith({})
    tg.emit(ANNA.id, '/page KYC down', ANNA.id, { date: new Date(Date.now() - 10 * 60_000).toISOString() })
    await settle()
    expect(daemon.pager.active()).toHaveLength(0)
    expect(tg.sent).toHaveLength(0)
    tg.emit(ANNA.id, '/page KYC down', ANNA.id, { date: new Date(Date.now() - 30_000).toISOString() })
    await settle()
    expect(daemon.pager.active()).toHaveLength(1)
    await daemon.stop()
  })
})
