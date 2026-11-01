import type { IncomingMessage, ServerMessage, TgEvent, WatchSpec } from '../shared/protocol'

export interface Sink {
  send(data: string): unknown
}

interface Session {
  id: string
  label: string
  channel: boolean
  proxy: Sink | null
  monitors: Set<Sink>
  watches: Map<string, WatchSpec>
  queue: TgEvent[]
  dropped: number
  disconnectedAt: number | null
}

export interface HubOptions {
  /** How long a session's watches survive after its proxy disconnects (daemon or network blip). */
  graceMs?: number
  maxQueue?: number
  now?: () => number
  log?: (msg: string) => void
}

export function newId(prefix: string): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return prefix + Array.from(bytes, b => alphabet[b % alphabet.length]).join('')
}

/**
 * Sessions, their watches, and getting each matching message to them exactly once.
 * Delivery goes to the first live path: the proxy (channel mode), else any Monitor
 * WebSocket, else a bounded queue that telegram_get_events or the next consumer drains.
 */
export class SessionHub {
  readonly #sessions = new Map<string, Session>()
  readonly #graceMs: number
  readonly #maxQueue: number
  readonly #now: () => number
  readonly #log: (msg: string) => void
  #seq = 0

  constructor(opts: HubOptions = {}) {
    this.#graceMs = opts.graceMs ?? 5 * 60_000
    this.#maxQueue = opts.maxQueue ?? 200
    this.#now = opts.now ?? Date.now
    this.#log = opts.log ?? (() => {})
  }

  #ensure(id: string, label = id): Session {
    let s = this.#sessions.get(id)
    if (!s) {
      s = {
        id,
        label,
        channel: false,
        proxy: null,
        monitors: new Set(),
        watches: new Map(),
        queue: [],
        dropped: 0,
        disconnectedAt: this.#now(),
      }
      this.#sessions.set(id, s)
    }
    return s
  }

  has(id: string): boolean {
    return this.#sessions.has(id)
  }

  /** A proxy said hello. If the daemon restarted it no longer knows this session, so the proxy's copy of its watches is restored. */
  attachProxy(id: string, info: { label: string; channel: boolean; watches: WatchSpec[] }, sink: Sink): void {
    const known = this.#sessions.has(id)
    const s = this.#ensure(id, info.label)
    s.label = info.label
    s.channel = info.channel
    s.proxy = sink
    s.disconnectedAt = null
    if (!known || s.watches.size === 0) {
      for (const w of info.watches) s.watches.set(w.id, w)
    }
    this.#flush(s)
  }

  detachProxy(id: string, sink: Sink): void {
    const s = this.#sessions.get(id)
    if (!s || s.proxy !== sink) return
    s.proxy = null
    s.disconnectedAt = this.#now()
  }

  attachMonitor(id: string, sink: Sink): boolean {
    const s = this.#sessions.get(id)
    if (!s) return false
    s.monitors.add(sink)
    this.#flush(s)
    return true
  }

  detachMonitor(id: string, sink: Sink): void {
    this.#sessions.get(id)?.monitors.delete(sink)
  }

  monitorCount(id: string): number {
    return this.#sessions.get(id)?.monitors.size ?? 0
  }

  isChannel(id: string): boolean {
    return this.#sessions.get(id)?.channel ?? false
  }

  addWatch(id: string, spec: Omit<WatchSpec, 'id' | 'createdAt'>): WatchSpec {
    const s = this.#ensure(id)
    const watch: WatchSpec = { ...spec, id: newId('w_'), createdAt: this.#now() }
    s.watches.set(watch.id, watch)
    this.#syncWatches(s)
    return watch
  }

  removeWatch(id: string, watchId: string): boolean {
    const s = this.#sessions.get(id)
    const removed = s?.watches.delete(watchId) ?? false
    if (s && removed) this.#syncWatches(s)
    return removed
  }

  clearWatches(id: string): number {
    const s = this.#sessions.get(id)
    if (!s) return 0
    const n = s.watches.size
    s.watches.clear()
    this.#syncWatches(s)
    return n
  }

  watches(id: string): WatchSpec[] {
    return [...(this.#sessions.get(id)?.watches.values() ?? [])]
  }

  isWatching(id: string, chatId: number): boolean {
    for (const w of this.#sessions.get(id)?.watches.values() ?? []) if (w.chatId === chatId) return true
    return false
  }

  pending(id: string): number {
    return this.#sessions.get(id)?.queue.length ?? 0
  }

  drain(id: string): { events: TgEvent[]; dropped: number } {
    const s = this.#sessions.get(id)
    if (!s) return { events: [], dropped: 0 }
    const out = { events: s.queue, dropped: s.dropped }
    s.queue = []
    s.dropped = 0
    return out
  }

  /** Routes one incoming Telegram message to every session with a matching watch. */
  dispatch(msg: IncomingMessage, describe: (msg: IncomingMessage) => Omit<TgEvent, 'seq' | 'watchIds'>): number {
    if (msg.outgoing) return 0
    let delivered = 0
    for (const s of this.#sessions.values()) {
      const hits = [...s.watches.values()].filter(
        w =>
          w.chatId === msg.chatId &&
          (w.fromId === undefined || w.fromId === msg.from?.id) &&
          (w.topicId === undefined || w.topicId === msg.topicId),
      )
      if (hits.length === 0) continue
      const event: TgEvent = { ...describe(msg), seq: ++this.#seq, watchIds: hits.map(w => w.id) }
      this.#deliver(s, event)
      delivered++
    }
    return delivered
  }

  /** Forgets sessions whose proxy has been gone longer than the grace period. */
  sweep(): string[] {
    const gone: string[] = []
    const now = this.#now()
    for (const s of this.#sessions.values()) {
      if (s.proxy === null && s.disconnectedAt !== null && now - s.disconnectedAt > this.#graceMs) {
        for (const m of s.monitors) (m as { close?: () => void }).close?.()
        this.#sessions.delete(s.id)
        gone.push(s.id)
      }
    }
    return gone
  }

  summary() {
    return [...this.#sessions.values()].map(s => ({
      id: s.id,
      label: s.label,
      connected: s.proxy !== null,
      channel: s.channel,
      monitors: s.monitors.size,
      watches: s.watches.size,
      pending: s.queue.length,
    }))
  }

  #deliver(s: Session, event: TgEvent) {
    if (s.channel && s.proxy) {
      s.proxy.send(JSON.stringify({ t: 'event', event } satisfies ServerMessage))
      return
    }
    if (s.monitors.size > 0) {
      const frame = formatEvent(event)
      for (const m of s.monitors) m.send(frame)
      return
    }
    s.queue.push(event)
    if (s.queue.length > this.#maxQueue) {
      s.queue.shift()
      s.dropped++
    }
  }

  #flush(s: Session) {
    if (s.queue.length === 0) return
    if (!(s.channel && s.proxy) && s.monitors.size === 0) return
    const { events, dropped } = this.drain(s.id)
    if (dropped > 0) this.#log(`session ${s.id}: ${dropped} watched messages were dropped while nobody was listening`)
    for (const e of events) this.#deliver(s, e)
  }

  #syncWatches(s: Session) {
    s.proxy?.send(JSON.stringify({ t: 'watches', watches: [...s.watches.values()] } satisfies ServerMessage))
  }
}

/** One readable block per message, for Monitor notifications and get_events. */
export function formatEvent(e: TgEvent): string {
  const who = e.fromUsername ? `${e.fromName} (@${e.fromUsername})` : e.fromName
  const where = e.chatNickname ? `${e.chatLabel} [${e.chatNickname}]` : e.chatLabel
  const head = [
    `Telegram message from ${who} in ${where}`,
    `chat_id ${e.chatId}`,
    `message_id ${e.messageId}`,
    e.topicId !== null ? `topic ${e.topicId}` : null,
    e.replyToId !== null ? `reply to ${e.replyToId}` : null,
    `watch ${e.watchIds.join(',')}`,
  ]
    .filter(Boolean)
    .join(' · ')
  const body = e.text || (e.media ? `[${e.media}]` : '[empty message]')
  return `${head}\n${e.media && e.text ? `[${e.media}] ` : ''}${body}`
}
