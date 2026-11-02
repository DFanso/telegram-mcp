import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SendOptions, TelegramPort } from '../src/daemon/telegram'
import type { DialogInfo, DownloadedFile, IncomingMessage, MessageInfo, PeerInfo, TelegramState } from '../src/shared/protocol'
import { downloadFileName } from '../src/shared/media'

/** In-memory stand-in for Telegram. Never touches the network. */
export class FakeTelegram implements TelegramPort {
  me: PeerInfo = { id: 1, type: 'user', name: 'Me', username: 'me_user', isSelf: true }
  peers = new Map<number, PeerInfo>()
  /** Ids that getPeer(id) pretends not to know yet (no access hash), like a fresh session. */
  uncached = new Set<number>()
  sent: { chatId: number; text: string; opts: SendOptions }[] = []
  history = new Map<number, MessageInfo[]>()
  /** Attachments by `${chatId}:${messageId}`. */
  files = new Map<string, { name: string | null; type: string; mime: string | null; data: string }>()
  phase: TelegramState['phase'] = 'connected'
  #listeners: ((m: IncomingMessage) => void)[] = []
  #nextId = 1000

  add(...peers: PeerInfo[]): this {
    for (const p of peers) this.peers.set(p.id, p)
    return this
  }

  state(): TelegramState {
    return { phase: this.phase, me: this.phase === 'connected' ? this.me : null, since: 0, reconnects: 0, lastError: null }
  }
  start() {}
  async stop() {}
  async reconnect() {}
  onMessage(cb: (m: IncomingMessage) => void) {
    this.#listeners.push(cb)
  }

  emit(chatId: number, text: string, fromId = chatId, extra: Partial<IncomingMessage> = {}): IncomingMessage {
    const chat = this.peers.get(chatId)!
    const from = this.peers.get(fromId) ?? null
    const msg: IncomingMessage = {
      id: this.#nextId++,
      chatId,
      chat,
      date: new Date().toISOString(),
      from,
      outgoing: false,
      text,
      media: null,
      replyToId: null,
      topicId: null,
      ...extra,
    }
    for (const l of this.#listeners) l(msg)
    return msg
  }

  async getPeer(ref: number | string): Promise<PeerInfo> {
    if (ref === 'me') return this.me
    if (typeof ref === 'number') {
      const p = this.peers.get(ref)
      if (!p || this.uncached.has(ref)) throw new Error(`peer ${ref} not found`)
      return p
    }
    const u = ref.replace(/^@/, '').toLowerCase()
    for (const p of this.peers.values()) if (p.username?.toLowerCase() === u) return p
    throw new Error(`USERNAME_NOT_OCCUPIED: @${u}`)
  }

  async sendText(chatId: number, text: string, opts: SendOptions = {}): Promise<MessageInfo> {
    this.sent.push({ chatId, text, opts })
    return {
      id: this.#nextId++,
      chatId,
      date: new Date().toISOString(),
      from: this.me,
      outgoing: true,
      text,
      media: null,
      replyToId: opts.replyTo ?? null,
      topicId: opts.topicId ?? null,
    }
  }

  async getHistory(chatId: number, opts: { limit: number }): Promise<MessageInfo[]> {
    return (this.history.get(chatId) ?? []).slice(-opts.limit)
  }

  async listDialogs(opts: { limit: number }): Promise<DialogInfo[]> {
    for (const id of this.uncached) this.uncached.delete(id)
    return [...this.peers.values()].slice(0, opts.limit).map(peer => ({ peer, unread: 0, pinned: false, lastMessage: null }))
  }

  async searchChats(query: string): Promise<(PeerInfo & { global: boolean })[]> {
    const q = query.toLowerCase()
    return [...this.peers.values()]
      .filter(p => p.name.toLowerCase().includes(q) || p.username?.toLowerCase().includes(q))
      .map(p => ({ ...p, global: false }))
  }

  async markRead() {}

  async downloadMedia(chatId: number, messageId: number, dir: string, maxBytes: number): Promise<DownloadedFile> {
    const f = this.files.get(`${chatId}:${messageId}`)
    if (!f) throw new Error(`Message #${messageId} has no attachment, nothing to download.`)
    if (f.data.length > maxBytes) throw new Error(`Message #${messageId} is over the limit.`)
    const name = downloadFileName(messageId, f)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), f.data)
    return { path: join(dir, name), name, size: f.data.length, mime: f.mime }
  }
}

export const LEO: PeerInfo = { id: 10, type: 'user', name: 'Leo Perera', username: 'leo_p' }
export const LEONARDO: PeerInfo = { id: 11, type: 'user', name: 'Leonardo Silva', username: 'leonardo_s' }
export const ANNA: PeerInfo = { id: 12, type: 'user', name: 'Anna K', username: 'anna_k' }
export const TEAM_QA: PeerInfo = { id: -1001234567890, type: 'group', name: 'Team QA', username: null, isForum: true }
export const ALL_HANDS: PeerInfo = { id: -1005550001111, type: 'group', name: 'Company All-Hands', username: null }
