import { describe, expect, test } from 'bun:test'
import { SessionHub } from '../src/daemon/sessions'
import type { IncomingMessage, TgEvent } from '../src/shared/protocol'

const describeMsg = (m: IncomingMessage): Omit<TgEvent, 'seq' | 'watchIds'> => ({
  chatId: m.chatId,
  chatLabel: m.chat.name,
  fromId: m.from?.id ?? null,
  fromName: m.from?.name ?? '?',
  fromUsername: null,
  messageId: m.id,
  topicId: m.topicId,
  replyToId: null,
  text: m.text,
  media: null,
  date: m.date,
})

let nextId = 1
function msg(chatId: number, fromId: number, text: string, extra: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: nextId++,
    chatId,
    chat: { id: chatId, type: 'group', name: `chat ${chatId}`, username: null },
    from: { id: fromId, type: 'user', name: `user ${fromId}`, username: null },
    date: '2026-11-01T00:00:00Z',
    outgoing: false,
    text,
    media: null,
    replyToId: null,
    topicId: null,
    ...extra,
  }
}

const sink = () => {
  const got: string[] = []
  return { got, send: (d: string) => got.push(d) }
}

describe('SessionHub', () => {
  test('queues until something listens, then flushes to a Monitor', () => {
    const hub = new SessionHub()
    const proxy = sink()
    hub.attachProxy('s1', { label: 'a', channel: false, watches: [] }, proxy)
    hub.addWatch('s1', { chatId: -5, chatLabel: 'g' })
    hub.dispatch(msg(-5, 7, 'first'), describeMsg)
    expect(hub.pending('s1')).toBe(1)

    const monitor = sink()
    hub.attachMonitor('s1', monitor)
    expect(hub.pending('s1')).toBe(0)
    expect(monitor.got[0]).toContain('first')
    hub.dispatch(msg(-5, 7, 'second'), describeMsg)
    expect(monitor.got[1]).toContain('second')
  })

  test('channel mode pushes to the proxy', () => {
    const hub = new SessionHub()
    const proxy = sink()
    hub.attachProxy('s1', { label: 'a', channel: true, watches: [] }, proxy)
    hub.addWatch('s1', { chatId: -5, chatLabel: 'g' })
    hub.dispatch(msg(-5, 7, 'hello'), describeMsg)
    const events = proxy.got.map(g => JSON.parse(g)).filter(m => m.t === 'event')
    expect(events).toHaveLength(1)
    expect(events[0].event.text).toBe('hello')
  })

  test('filters by sender and topic, ignores outgoing', () => {
    const hub = new SessionHub()
    hub.attachProxy('s1', { label: 'a', channel: false, watches: [] }, sink())
    hub.addWatch('s1', { chatId: -5, chatLabel: 'g', fromId: 7, topicId: 3 })
    expect(hub.dispatch(msg(-5, 8, 'other sender', { topicId: 3 }), describeMsg)).toBe(0)
    expect(hub.dispatch(msg(-5, 7, 'other topic', { topicId: 4 }), describeMsg)).toBe(0)
    expect(hub.dispatch(msg(-5, 7, 'mine', { topicId: 3, outgoing: true }), describeMsg)).toBe(0)
    expect(hub.dispatch(msg(-5, 7, 'yes', { topicId: 3 }), describeMsg)).toBe(1)
  })

  test('a restarted daemon restores watches from the proxy hello', () => {
    const first = new SessionHub()
    const proxy = sink()
    first.attachProxy('s1', { label: 'a', channel: false, watches: [] }, proxy)
    first.addWatch('s1', { chatId: -5, chatLabel: 'g' })
    const synced = proxy.got.map(g => JSON.parse(g)).filter(m => m.t === 'watches').at(-1).watches

    const second = new SessionHub()
    second.attachProxy('s1', { label: 'a', channel: false, watches: synced }, sink())
    expect(second.isWatching('s1', -5)).toBe(true)
  })

  test('sessions expire after the grace period without a proxy', () => {
    let now = 0
    const hub = new SessionHub({ graceMs: 1000, now: () => now })
    const proxy = sink()
    hub.attachProxy('s1', { label: 'a', channel: false, watches: [] }, proxy)
    hub.detachProxy('s1', proxy)
    now = 500
    expect(hub.sweep()).toEqual([])
    now = 1500
    expect(hub.sweep()).toEqual(['s1'])
    expect(hub.has('s1')).toBe(false)
  })

  test('queue is bounded', () => {
    const hub = new SessionHub({ maxQueue: 2 })
    hub.attachProxy('s1', { label: 'a', channel: false, watches: [] }, sink())
    hub.addWatch('s1', { chatId: -5, chatLabel: 'g' })
    for (const t of ['a', 'b', 'c']) hub.dispatch(msg(-5, 7, t), describeMsg)
    const { events, dropped } = hub.drain('s1')
    expect(events.map(e => e.text)).toEqual(['b', 'c'])
    expect(dropped).toBe(1)
  })
})
