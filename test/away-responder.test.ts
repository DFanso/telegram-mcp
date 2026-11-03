import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AwayResponder, type AwayDeps } from '../src/daemon/away'
import { AWAY_MAX_PER_WINDOW } from '../src/shared/away'
import { parseConfig, type Config } from '../src/shared/config'
import type { IncomingMessage, PeerInfo, SentRecord } from '../src/shared/protocol'
import { ANNA, FakeTelegram, LEO, TEAM_QA } from './fake-telegram'

const BOT: PeerInfo = { id: 77, type: 'bot', name: 'Helper Bot', username: 'helper_bot' }
const TELEGRAM: PeerInfo = { id: 777000, type: 'user', name: 'Telegram', username: null }
const SUPPORT: PeerInfo = { id: 4242, type: 'user', name: 'Volunteer Support', username: null, isSupport: true }
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m)

function cfg(
  over: {
    away?: object
    blocked?: number[]
    autoReply?: number[]
    requireApproval?: number[]
    autoSend?: number[]
    defaultPolicy?: 'approve' | 'block'
  } = {},
): Config {
  return parseConfig(
    JSON.stringify({
      footer: '\n\nF',
      defaultPolicy: over.defaultPolicy ?? 'approve',
      away: { enabled: true, from: '18:00', until: '09:00', message: '{name} is out 🔥', quietMinutes: 30, ...over.away },
      rules: {
        blocked: over.blocked ?? [],
        autoReply: over.autoReply ?? [],
        requireApproval: over.requireApproval ?? [],
        autoSend: over.autoSend ?? [],
      },
    }),
  )
}

/** A person nobody has saved: a stranger writing in. */
const stranger = (n: number): PeerInfo => ({ id: 5000 + n, type: 'user', name: `Stranger ${n}`, username: null })

let tg: FakeTelegram
let config: Config
let clock: number
let records: Omit<SentRecord, 'at'>[]
let hub: { handledLive: (id: number) => boolean; takeoverOf: (id: number) => string | null }
let pages: { senderKey: string }[]
let logs: string[]

const make = (extra: Partial<AwayDeps> = {}) =>
  new AwayResponder({
    config: () => config,
    tg,
    hub,
    pages: () => pages,
    record: r => records.push(r),
    now: () => clock,
    log: m => logs.push(m),
    ...extra,
  })

/** An incoming message dated `when` (defaults to the clock). */
function msg(chat: PeerInfo, when = new Date(clock), extra: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: Math.floor(Math.random() * 1e6),
    chatId: chat.id,
    chat,
    date: when.toISOString(),
    from: chat,
    outgoing: false,
    text: 'hi',
    media: null,
    replyToId: null,
    topicId: null,
    ...extra,
  }
}

beforeEach(() => {
  tg = new FakeTelegram().add(LEO, ANNA, TEAM_QA, BOT)
  config = cfg()
  clock = at(3, 20).getTime()
  records = []
  hub = { handledLive: () => false, takeoverOf: () => null }
  pages = []
  logs = []
})

describe('AwayResponder', () => {
  test('replies once to a private message in the window', async () => {
    const r = make()
    expect(await r.onIncoming(msg(ANNA), false)).toBe('sent')
    expect(tg.sent).toEqual([{ chatId: ANNA.id, text: 'Me is out 🔥\n\nF', opts: {} }])
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ via: 'away', chatId: ANNA.id, sessionLabel: null, text: 'Me is out 🔥\n\nF' })
    expect(logs).toContain(`away reply to ${ANNA.id}`)
    clock = at(3, 21).getTime()
    expect(await r.onIncoming(msg(ANNA), false)).toBe('skipped')
    expect(tg.sent).toHaveLength(1)
  })

  test('two quick messages get one reply', async () => {
    const r = make()
    const a = r.onIncoming(msg(ANNA), false)
    const b = r.onIncoming(msg(ANNA), false)
    await Promise.all([a, b])
    expect(tg.sent).toHaveLength(1)
  })

  const skipCases: [string, () => IncomingMessage][] = [
    ['outside the window', () => { clock = at(3, 17, 59).getTime(); return msg(ANNA) }],
    ['when disabled', () => { config = cfg({ away: { enabled: false } }); return msg(ANNA) }],
    ['to groups', () => msg(TEAM_QA, undefined, { from: ANNA })],
    ['to bots', () => msg(BOT)],
    ["to Telegram's service account (777000)", () => msg(TELEGRAM)],
    ['to Telegram support', () => msg(SUPPORT)],
    ['to self', () => msg({ ...ANNA, isSelf: true })],
    ['to outgoing messages', () => msg(ANNA, undefined, { outgoing: true })],
    ['to a blocked chat', () => { config = cfg({ blocked: [ANNA.id] }); return msg(ANNA) }],
    ['to an Ask every time chat (requireApproval)', () => { config = cfg({ requireApproval: [ANNA.id] }); return msg(ANNA) }],
    ['to an unlisted chat when defaultPolicy is block', () => { config = cfg({ defaultPolicy: 'block' }); return msg(ANNA) }],
  ]
  for (const [name, build] of skipCases) {
    test(`no reply ${name}`, async () => {
      const m = build()
      expect(await make().onIncoming(m, false)).toBe('skipped')
      expect(tg.sent).toEqual([])
    })
  }

  test('defaultPolicy block still lets an Always allow chat get a reply', async () => {
    config = cfg({ defaultPolicy: 'block', autoSend: [ANNA.id] })
    expect(await make().onIncoming(msg(ANNA), false)).toBe('sent')
  })

  test('no reply once the hours are over, though the message came in before', async () => {
    const sentAt = at(4, 8, 58)
    clock = at(4, 9, 5).getTime() // caught up after a sleep or a reconnect
    expect(await make().onIncoming(msg(ANNA, sentAt), false)).toBe('skipped')
    clock = at(4, 8, 59).getTime()
    expect(await make().onIncoming(msg(ANNA, sentAt), false)).toBe('sent')
  })

  test(`at most ${AWAY_MAX_PER_WINDOW} replies a night, logged once`, async () => {
    const r = make()
    for (let i = 0; i < AWAY_MAX_PER_WINDOW; i++) expect(await r.onIncoming(msg(stranger(i)), false)).toBe('sent')
    expect(await r.onIncoming(msg(stranger(100)), false)).toBe('skipped')
    expect(await r.onIncoming(msg(stranger(101)), false)).toBe('skipped')
    expect(tg.sent).toHaveLength(AWAY_MAX_PER_WINDOW)
    expect(logs.filter(l => l.includes('limit'))).toHaveLength(1)
    // The next night starts again.
    clock = at(4, 20).getTime()
    expect(await r.onIncoming(msg(stranger(100)), false)).toBe('sent')
  })

  test('the nightly limit survives a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'away-cap-'))
    try {
      const statePath = join(dir, 'away.json')
      const first = make({ statePath })
      for (let i = 0; i < AWAY_MAX_PER_WINDOW; i++) await first.onIncoming(msg(stranger(i)), false)
      expect(await make({ statePath }).onIncoming(msg(stranger(100)), false)).toBe('skipped')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('no reply to a message older than 10 minutes', async () => {
    clock = at(3, 20, 15).getTime()
    const r = make()
    expect(await r.onIncoming(msg(ANNA, at(3, 20, 4)), false)).toBe('skipped')
    expect(await r.onIncoming(msg(ANNA, at(3, 20, 6)), false)).toBe('sent')
  })

  test('no reply when you spoke recently', async () => {
    const r = make()
    r.noteOutgoing(ANNA.id, at(3, 19, 50).getTime())
    clock = at(3, 20, 10).getTime()
    expect(await r.onIncoming(msg(ANNA), false)).toBe('skipped')
    clock = at(3, 20, 21).getTime()
    expect(await r.onIncoming(msg(ANNA), false)).toBe('sent')
  })

  test('quietMinutes 0 ignores recent outgoing', async () => {
    config = cfg({ away: { quietMinutes: 0 } })
    const r = make()
    r.noteOutgoing(ANNA.id, clock - 60_000)
    expect(await r.onIncoming(msg(ANNA), false)).toBe('sent')
  })

  test('no reply while a Claude session is live on the chat', async () => {
    hub.takeoverOf = () => 's1'
    expect(await make().onIncoming(msg(ANNA), false)).toBe('skipped')
    hub.takeoverOf = () => null
    hub.handledLive = () => true
    config = cfg({ autoReply: [ANNA.id] })
    expect(await make().onIncoming(msg(ANNA), false)).toBe('skipped')
    // A live watch on a chat that is not on autoReply is never dispatched to by main.ts.
    config = cfg()
    expect(await make().onIncoming(msg(ANNA), false)).toBe('sent')
  })

  test('no reply to a message that paged', async () => {
    const r = make()
    expect(await r.onIncoming(msg(ANNA), true)).toBe('skipped')
    pages = [{ senderKey: String(ANNA.id) }]
    expect(await r.onIncoming(msg(ANNA), false)).toBe('skipped')
    expect(tg.sent).toEqual([])
  })

  test('the away reply itself does not count as you speaking', async () => {
    // A full day of quiet: if the reply at 20:00 counted as you writing, 19:00 tomorrow would be silenced.
    config = cfg({ away: { quietMinutes: 1440 } })
    const r = make()
    expect(await r.onIncoming(msg(ANNA), false)).toBe('sent')
    clock = at(4, 19).getTime()
    expect(await r.onIncoming(msg(ANNA), false)).toBe('sent')
  })

  test('editing the hours mid-night does not reply again', async () => {
    const r = make()
    expect(await r.onIncoming(msg(ANNA), false)).toBe('sent')
    config = cfg({ away: { from: '17:00' } })
    clock = at(3, 21).getTime()
    expect(await r.onIncoming(msg(ANNA), false)).toBe('skipped')
    expect(tg.sent).toHaveLength(1)
  })

  test("yesterday's answered set does not block tonight", async () => {
    const r = make()
    await r.onIncoming(msg(ANNA), false)
    clock = at(4, 20).getTime()
    expect(await r.onIncoming(msg(ANNA), false)).toBe('sent')
    expect(tg.sent).toHaveLength(2)
  })

  test('answered set survives a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'away-'))
    try {
      const statePath = join(dir, 'away.json')
      await make({ statePath }).onIncoming(msg(ANNA), false)
      clock = at(3, 23).getTime()
      expect(await make({ statePath }).onIncoming(msg(ANNA), false)).toBe('skipped')
      expect(tg.sent).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an away.json from an earlier build still blocks that night', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'away-'))
    try {
      const statePath = join(dir, 'away.json')
      writeFileSync(statePath, JSON.stringify({ window: '2026-11-03T18:00', chats: [ANNA.id] }))
      const r = make({ statePath })
      expect(await r.onIncoming(msg(ANNA), false)).toBe('skipped')
      expect(await r.onIncoming(msg(LEO), false)).toBe('sent')
      // Saved back in the new shape, ANNA kept.
      const saved = JSON.parse(readFileSync(statePath, 'utf8'))
      expect(Object.keys(saved.replied).map(Number).sort()).toEqual([ANNA.id, LEO.id].sort())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an unreadable away.json is ignored', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'away-'))
    try {
      const statePath = join(dir, 'away.json')
      for (const junk of ['not json', 'null', '[]', '{"replied": 5}', '{"window": 3, "chats": "x"}', '{"window": "soon", "chats": [1]}']) {
        writeFileSync(statePath, junk)
        tg.sent = []
        expect(await make({ statePath }).onIncoming(msg(ANNA), false)).toBe('sent')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('old entries are dropped from away.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'away-'))
    try {
      const statePath = join(dir, 'away.json')
      await make({ statePath }).onIncoming(msg(ANNA), false)
      clock = at(6, 20).getTime()
      await make({ statePath }).onIncoming(msg(LEO), false)
      expect(Object.keys(JSON.parse(readFileSync(statePath, 'utf8')).replied)).toEqual([String(LEO.id)])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a failed send is not remembered', async () => {
    const real = tg.sendText.bind(tg)
    let fail = true
    tg.sendText = async (...a: Parameters<typeof real>) => {
      if (fail) {
        fail = false
        throw new Error('flood')
      }
      return real(...a)
    }
    const r = make()
    expect(await r.onIncoming(msg(ANNA), false)).toBe('skipped')
    expect(records).toEqual([])
    expect(logs.some(l => l.startsWith('away:'))).toBe(true)
    expect(await r.onIncoming(msg(ANNA), false)).toBe('sent')
  })

  test('turning it off stops replies at once', async () => {
    const r = make()
    expect(await r.onIncoming(msg(ANNA), false)).toBe('sent')
    config = cfg({ away: { enabled: false } })
    expect(await r.onIncoming(msg(LEO), false)).toBe('skipped')
  })

  test('ui() and summary()', () => {
    const r = make()
    const ui = r.ui()
    expect(ui).toMatchObject({ enabled: true, from: '18:00', until: '09:00', active: true, quietMinutes: 30, preview: 'Me is out 🔥\n\nF' })
    expect(ui.nextChange).toBe(at(4, 9).toISOString())
    expect(r.summary()).toBe('on, 18:00–09:00 (active now, until 09:00)')
    tg.phase = 'logged_out'
    expect(r.ui().preview).toBe('{name} is out 🔥\n\nF')
  })
})
