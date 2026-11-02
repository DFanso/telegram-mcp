import { Chat, TelegramClient, User, html, md, type ITelegramStorageProvider, type Message, type Peer, type tl } from '@mtcute/bun'
import type {
  DialogInfo,
  IncomingMessage,
  MessageInfo,
  PeerInfo,
  TelegramState,
} from '../shared/protocol'
import type { Credentials } from '../shared/secrets'
import { SessionLockedError } from './session-store'

export interface SendOptions {
  replyTo?: number
  topicId?: number
  parseMode?: 'plain' | 'markdown' | 'html'
}

/** Everything the daemon needs from Telegram. Tests swap in a fake. */
export interface TelegramPort {
  state(): TelegramState
  start(): void
  stop(): Promise<void>
  reconnect(reason: string): Promise<void>
  onMessage(cb: (msg: IncomingMessage) => void): void
  getPeer(ref: number | string): Promise<PeerInfo>
  sendText(chatId: number, text: string, opts?: SendOptions): Promise<MessageInfo>
  getHistory(chatId: number, opts: { limit: number; beforeId?: number; topicId?: number }): Promise<MessageInfo[]>
  listDialogs(opts: { limit: number; unreadOnly: boolean }): Promise<DialogInfo[]>
  searchChats(query: string, limit: number): Promise<(PeerInfo & { global: boolean })[]>
  markRead(chatId: number): Promise<void>
}

// ---- conversions ----------------------------------------------------------------

export function peerInfo(p: Peer): PeerInfo {
  if (p.type === 'user') {
    return { id: p.id, type: p.isBot ? 'bot' : 'user', name: p.displayName, username: p.username, isSelf: p.isSelf }
  }
  return {
    id: p.id,
    type: p.chatType === 'channel' ? 'channel' : 'group',
    name: p.displayName,
    username: p.username,
    isForum: p.isForum,
  }
}

function safeSender(m: Message): PeerInfo | null {
  try {
    return peerInfo(m.sender)
  } catch {
    return null
  }
}

export function messageInfo(m: Message): MessageInfo {
  const reply = m.replyToMessage
  const topicId = reply?.threadId ?? null
  let replyToId = reply?.id ?? null
  // In a forum, a message "replying" to the topic root is just a message in that topic.
  if (reply?.isForumTopic && replyToId === topicId) replyToId = null
  return {
    id: m.id,
    chatId: m.chat.id,
    date: m.date.toISOString(),
    from: safeSender(m),
    outgoing: m.isOutgoing,
    text: m.text,
    media: m.media ? m.media.type : null,
    replyToId,
    topicId,
  }
}

function markedFromTlPeer(p: tl.TypePeer): number {
  if (p._ === 'peerUser') return p.userId
  if (p._ === 'peerChat') return -p.chatId
  return -1_000_000_000_000 - p.channelId
}

const LOGGED_OUT = new Set([
  'AUTH_KEY_UNREGISTERED',
  'AUTH_KEY_INVALID',
  'SESSION_REVOKED',
  'SESSION_EXPIRED',
  'USER_DEACTIVATED',
  'USER_DEACTIVATED_BAN',
])

function isLoggedOutError(e: unknown): boolean {
  const text = (e as { text?: unknown })?.text
  return typeof text === 'string' && LOGGED_OUT.has(text)
}

/** Retrying can't fix these: the api_id/api_hash themselves are wrong. */
function isBadCredentialsError(e: unknown): boolean {
  const text = (e as { text?: unknown })?.text
  return typeof text === 'string' && (text === 'API_ID_INVALID' || text === 'API_ID_PUBLISHED_FLOOD')
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms)
    p.then(
      v => {
        clearTimeout(timer)
        resolve(v)
      },
      e => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---- the real client, with a supervisor around it ------------------------------------

export interface MtcuteOptions {
  /** Opens session.db for one client. A SessionLockedError means only `tgmcp login` can help. */
  openStorage: () => Promise<ITelegramStorageProvider>
  /** Reads api_id/api_hash. Throws when the keystore can't be read (retried with backoff). */
  loadCredentials: () => Promise<Credentials | null>
  log: (msg: string) => void
  /** How often the watchdog checks the connection. */
  tickMs?: number
  /** A tick this much later than scheduled means the machine slept. */
  sleepGapMs?: number
  /** Give up on mtcute's own reconnect and rebuild the client after this long without a connection. */
  stuckMs?: number
}

/**
 * Owns the mtcute client and keeps it alive without a human:
 * - mtcute reconnects dropped sockets by itself;
 * - a watchdog pings Telegram every tick and rebuilds the client when pings fail,
 *   when it's been stuck "connecting" too long, or right after the Mac wakes from sleep;
 * - rebuilds retry forever with backoff (capped at a minute);
 * - only a revoked or missing login stops it, because that needs `tgmcp login`.
 * If the process itself dies, launchd starts it again.
 */
export class MtcuteTelegram implements TelegramPort {
  #client: TelegramClient | null = null
  #state: TelegramState = { phase: 'starting', me: null, since: Date.now(), reconnects: 0, lastError: null }
  #listeners: ((msg: IncomingMessage) => void)[] = []
  #restarting: Promise<void> | null = null
  #timer: ReturnType<typeof setInterval> | null = null
  #stopped = false
  #lastTick = Date.now()
  #notConnectedSince: number | null = null
  #pingFailures = 0
  #seen = new Set<string>()
  readonly #o: Required<MtcuteOptions>

  constructor(opts: MtcuteOptions) {
    this.#o = { tickMs: 30_000, sleepGapMs: 90_000, stuckMs: 90_000, ...opts }
  }

  state(): TelegramState {
    return { ...this.#state }
  }

  onMessage(cb: (msg: IncomingMessage) => void): void {
    this.#listeners.push(cb)
  }

  start(): void {
    this.#stopped = false
    void this.#rebuild('startup')
    this.#timer ??= setInterval(() => void this.#tick(), this.#o.tickMs)
  }

  async stop(): Promise<void> {
    this.#stopped = true
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    await this.#teardown()
  }

  async reconnect(reason: string): Promise<void> {
    this.#stopped = false
    if (this.#restarting) await this.#restarting
    await this.#rebuild(reason)
  }

  #setPhase(phase: TelegramState['phase'], patch: Partial<TelegramState> = {}) {
    if (this.#state.phase !== phase) this.#o.log(`telegram: ${this.#state.phase} -> ${phase}`)
    this.#state = { ...this.#state, ...patch, phase, since: this.#state.phase === phase ? this.#state.since : Date.now() }
  }

  async #teardown() {
    const c = this.#client
    this.#client = null
    if (c) await withTimeout(c.destroy(), 10_000, 'closing the old client').catch(e => this.#o.log(`telegram: ${errText(e)}`))
  }

  /** Single-flight: concurrent callers share one rebuild. */
  #rebuild(reason: string): Promise<void> {
    if (this.#restarting) return this.#restarting
    this.#restarting = this.#rebuildLoop(reason).finally(() => {
      this.#restarting = null
    })
    return this.#restarting
  }

  async #rebuildLoop(reason: string) {
    this.#o.log(`telegram: (re)connecting, reason: ${reason}`)
    let attempt = 0
    const backoff = async (why: string) => {
      attempt++
      const delay = Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6))
      this.#state.lastError = `${why} (retrying in ${Math.round(delay / 1000)}s)`
      this.#o.log(`telegram: connect failed: ${this.#state.lastError}`)
      await sleep(delay)
    }
    while (!this.#stopped) {
      let creds: Credentials | null
      let storage: ITelegramStorageProvider
      try {
        creds = await this.#o.loadCredentials()
        if (!creds) {
          await this.#teardown()
          this.#setPhase('no_credentials', { lastError: 'No API id/hash. Run `tgmcp login`.' })
          return
        }
        // The old client holds session.db open; close it before opening it again.
        await this.#teardown()
        storage = await this.#o.openStorage()
      } catch (e) {
        if (e instanceof SessionLockedError) {
          await this.#teardown()
          this.#setPhase('logged_out', { me: null, lastError: e.message })
          return
        }
        // The keystore may be locked or waiting for a click; that passes, so keep trying.
        await this.#teardown()
        this.#setPhase('connecting')
        await backoff(errText(e))
        continue
      }
      this.#setPhase('connecting')
      this.#notConnectedSince ??= Date.now()
      const client = new TelegramClient({
        apiId: creds.apiId,
        apiHash: creds.apiHash,
        storage,
        updates: { catchUp: true },
        logLevel: 2,
      })
      this.#client = client
      client.onConnectionState.add(s => this.#onConnection(client, s))
      client.onNewMessage.add(m => this.#onNewMessage(client, m))
      client.onError.add(e => this.#o.log(`telegram client error: ${errText(e)}`))
      try {
        // Not client.start(): the Bun wrapper would prompt on stdin for a phone number and hang the daemon.
        const me = await withTimeout(client.getMe(), 60_000, 'getMe')
        await client.notifyLoggedIn(me.raw)
        if (reason !== 'startup') this.#state.reconnects++
        this.#pingFailures = 0
        this.#notConnectedSince = null
        this.#setPhase('connected', { me: peerInfo(me), lastError: null })
        return
      } catch (e) {
        if (isLoggedOutError(e)) {
          await this.#teardown()
          this.#setPhase('logged_out', { me: null, lastError: 'Not logged in (or the session was revoked). Run `tgmcp login`.' })
          return
        }
        if (isBadCredentialsError(e)) {
          await this.#teardown()
          this.#setPhase('no_credentials', { me: null, lastError: `Telegram rejected the api_id/api_hash (${errText(e)}). Run \`tgmcp login --credentials\` to enter them again.` })
          return
        }
        await backoff(errText(e))
      }
    }
  }

  #onConnection(client: TelegramClient, s: string) {
    if (client !== this.#client || this.#restarting) return
    if (s === 'connected' || s === 'updating') {
      this.#notConnectedSince = null
      if (this.#state.phase === 'connecting') this.#setPhase('connected')
    } else {
      this.#notConnectedSince ??= Date.now()
      if (this.#state.phase === 'connected') this.#setPhase('connecting')
    }
  }

  #onNewMessage(client: TelegramClient, m: Message) {
    if (client !== this.#client) return
    // Catch-up after a reconnect can replay messages; notify each one once.
    const key = `${m.chat.id}:${m.id}`
    if (this.#seen.has(key)) return
    this.#seen.add(key)
    if (this.#seen.size > 5_000) this.#seen = new Set([...this.#seen].slice(-2_500))
    let msg: IncomingMessage
    try {
      msg = { ...messageInfo(m), chat: peerInfo(m.chat) }
    } catch (e) {
      this.#o.log(`telegram: could not read an incoming message: ${errText(e)}`)
      return
    }
    for (const cb of this.#listeners) {
      try {
        cb(msg)
      } catch (e) {
        this.#o.log(`telegram: message listener failed: ${errText(e)}`)
      }
    }
  }

  async #tick() {
    const now = Date.now()
    const slept = now - this.#lastTick > this.#o.sleepGapMs
    this.#lastTick = now
    if (this.#stopped || this.#restarting) return
    const { phase } = this.#state
    if (phase === 'logged_out' || phase === 'no_credentials' || phase === 'starting') return
    if (slept) this.#o.log('telegram: woke from sleep, checking the connection')

    if (phase === 'connecting' && this.#notConnectedSince && now - this.#notConnectedSince > this.#o.stuckMs) {
      void this.#rebuild(`no connection for ${Math.round((now - this.#notConnectedSince) / 1000)}s`)
      return
    }
    const client = this.#client
    if (!client) {
      void this.#rebuild('no client')
      return
    }
    try {
      await withTimeout(client.call({ _: 'updates.getState' }), 15_000, 'ping')
      this.#pingFailures = 0
    } catch (e) {
      if (isLoggedOutError(e)) {
        await this.#teardown()
        this.#setPhase('logged_out', { me: null, lastError: 'Session revoked. Run `tgmcp login`.' })
        return
      }
      this.#pingFailures++
      this.#o.log(`telegram: ping failed (${this.#pingFailures}): ${errText(e)}`)
      if (slept || this.#pingFailures >= 2) void this.#rebuild('ping failed')
    }
  }

  /** Waits briefly for a connection so a call during a reconnect succeeds instead of failing. */
  async #ready(timeoutMs = 25_000): Promise<TelegramClient> {
    const deadline = Date.now() + timeoutMs
    while (true) {
      const { phase, lastError } = this.#state
      if (phase === 'logged_out' || phase === 'no_credentials') throw new Error(lastError ?? 'Not logged in. Run `tgmcp login`.')
      if (phase === 'connected' && this.#client && !this.#restarting) return this.#client
      if (Date.now() > deadline) {
        throw new Error(`Telegram is reconnecting (${lastError ?? phase}). The daemon keeps retrying on its own; try again shortly.`)
      }
      await sleep(250)
    }
  }

  async getPeer(ref: number | string): Promise<PeerInfo> {
    const c = await this.#ready()
    const input = typeof ref === 'string' ? ref.replace(/^@/, '') : ref
    return peerInfo(await c.getPeer(input))
  }

  async sendText(chatId: number, text: string, opts: SendOptions = {}): Promise<MessageInfo> {
    const c = await this.#ready()
    const body = opts.parseMode === 'markdown' ? md(text) : opts.parseMode === 'html' ? html(text) : text
    const sent = await c.sendText(chatId, body, {
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
      ...(opts.topicId ? { threadId: opts.topicId } : {}),
    })
    return messageInfo(sent)
  }

  async getHistory(chatId: number, opts: { limit: number; beforeId?: number; topicId?: number }): Promise<MessageInfo[]> {
    const c = await this.#ready()
    const list = opts.topicId
      ? await c.searchMessages({ chatId, threadId: opts.topicId, limit: opts.limit, maxId: opts.beforeId, query: '' })
      : await c.getHistory(chatId, { limit: opts.limit, maxId: opts.beforeId })
    return [...list].map(messageInfo).reverse()
  }

  async listDialogs(opts: { limit: number; unreadOnly: boolean }): Promise<DialogInfo[]> {
    const c = await this.#ready()
    const out: DialogInfo[] = []
    for await (const d of c.iterDialogs({ limit: opts.unreadOnly ? Math.max(opts.limit * 5, 200) : opts.limit })) {
      if (opts.unreadOnly && d.unreadCount === 0) continue
      const last = d.lastMessage
      out.push({
        peer: peerInfo(d.peer),
        unread: d.unreadCount,
        pinned: d.isPinned,
        lastMessage: last ? { id: last.id, date: last.date.toISOString(), text: last.text, outgoing: last.isOutgoing } : null,
      })
      if (out.length >= opts.limit) break
    }
    return out
  }

  async searchChats(query: string, limit: number): Promise<(PeerInfo & { global: boolean })[]> {
    const c = await this.#ready()
    const res = await c.call({ _: 'contacts.search', q: query, limit })
    const mine = new Set(res.myResults.map(markedFromTlPeer))
    const peers: PeerInfo[] = [
      ...res.users.filter(u => u._ === 'user').map(u => peerInfo(new User(u))),
      ...res.chats.map(ch => peerInfo(new Chat(ch))),
    ]
    return peers.map(p => ({ ...p, global: !mine.has(p.id) })).sort((a, b) => Number(a.global) - Number(b.global))
  }

  async markRead(chatId: number): Promise<void> {
    const c = await this.#ready()
    await c.readHistory(chatId)
  }
}
