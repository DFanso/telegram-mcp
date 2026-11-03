import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { AWAY_MAX_AGE_MS, AWAY_MAX_PER_WINDOW, awaySummary, awayWindowAt, firstName, nextAwayChange, renderAwayMessage } from '../shared/away'
import { isListed, type Config } from '../shared/config'
import { decideSend, withFooter } from '../shared/policy'
import type { IncomingMessage, SentRecord, UiAway } from '../shared/protocol'
import type { SessionHub } from './sessions'
import type { TelegramPort } from './telegram'

export interface AwayDeps {
  /** store.get(), read on every message. */
  config: () => Config
  tg: TelegramPort
  hub: Pick<SessionHub, 'handledLive' | 'takeoverOf'>
  /** pager?.active() ?? [] */
  pages: () => { senderKey: string }[]
  /** Service.recordSent */
  record: (r: Omit<SentRecord, 'at'>) => void
  /** away.json; absent = memory only. */
  statePath?: string
  now?: () => number
  log?: (msg: string) => void
}

/** Entries older than this are dropped on save: no away window is longer than a day. */
const REPLIED_KEEP_MS = 48 * 3_600_000

/** Telegram's own service account (login codes, security notices): never a person to answer. */
const TELEGRAM_SERVICE_ID = 777000

/**
 * away.json as an earlier build wrote it: `{ window: "YYYY-MM-DDTHH:MM", chats: [...] }`, the window
 * named by its local start. Read back as "answered at the window's start", which still blocks that night.
 */
function fromOldFormat(raw: { window: string; chats: unknown[] }): Map<number, number> {
  const out = new Map<number, number>()
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(raw.window)
  if (!m) return out
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number]
  const start = new Date(y, mo - 1, d, h, mi).getTime()
  for (const c of raw.chats) if (typeof c === 'number') out.set(c, start)
  return out
}

/** What a sender gets: the message with {name} filled in, plus the footer. */
export function awayText(config: Config, me: { name: string } | null | undefined): string {
  return withFooter(renderAwayMessage(config.away.message, firstName(me)), config.footer)
}

/** The away settings as the tray shows them. One place, so the responder and a Service without one agree. */
export function uiAway(config: Config, me: { name: string } | null | undefined, at: Date): UiAway {
  const { away } = config
  return {
    enabled: away.enabled,
    from: away.from,
    until: away.until,
    message: away.message,
    quietMinutes: away.quietMinutes,
    active: away.enabled && awayWindowAt(away, at) !== null,
    nextChange: nextAwayChange(away, at)?.toISOString() ?? null,
    preview: awayText(config, me),
  }
}

/** Sends at most one away reply per chat per away window, to people only, and never over a live Claude or page. */
export class AwayResponder {
  /** chat id -> when it last got an away reply (epoch ms). Loaded lazily from away.json. */
  #replied: Map<number, number> | null = null
  #lastOutgoing = new Map<number, number>()
  /** The window whose nightly limit was last logged, so it's logged once a night. */
  #limitLogged: string | null = null

  constructor(private d: AwayDeps) {}

  #now = () => (this.d.now ?? Date.now)()
  #log = (m: string) => this.d.log?.(m)

  #text(config: Config): string {
    return awayText(config, this.d.tg.state().me)
  }

  /** Who got an away reply when. Keyed by time, not by window, so editing the hours mid-night can't reset it. */
  #repliedMap(): Map<number, number> {
    if (this.#replied) return this.#replied
    this.#replied = new Map()
    if (!this.d.statePath) return this.#replied
    try {
      const raw = JSON.parse(readFileSync(this.d.statePath, 'utf8'))
      if (raw && typeof raw.replied === 'object' && !Array.isArray(raw.replied)) {
        for (const [k, v] of Object.entries(raw.replied as Record<string, unknown>)) {
          const id = Number(k)
          if (Number.isFinite(id) && typeof v === 'number' && Number.isFinite(v)) this.#replied.set(id, v)
        }
      } else if (typeof raw?.window === 'string' && Array.isArray(raw.chats)) {
        this.#replied = fromOldFormat(raw)
      }
    } catch {}
    return this.#replied
  }

  #save() {
    const replied = this.#replied
    if (!replied) return
    const cutoff = this.#now() - REPLIED_KEEP_MS
    for (const [id, t] of replied) if (t < cutoff) replied.delete(id)
    if (!this.d.statePath) return
    try {
      const tmp = `${this.d.statePath}.tmp`
      writeFileSync(tmp, JSON.stringify({ replied: Object.fromEntries(replied) }), { mode: 0o600 })
      renameSync(tmp, this.d.statePath)
    } catch (e) {
      this.#log(`away: could not save state: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async onIncoming(msg: IncomingMessage, paged: boolean): Promise<'sent' | 'skipped'> {
    try {
      const config = this.d.config()
      const { away } = config
      if (!away.enabled) return 'skipped' // R1
      if (msg.outgoing) return 'skipped' // R2
      const chat = msg.chat
      // R3: bots are type 'bot'; Telegram's service account and support staff are users but not people to answer.
      if (chat.type !== 'user' || chat.isSelf || chat.isSupport || chat.id === TELEGRAM_SERVICE_ID) return 'skipped'
      // R4: the chat's rules, as for the pager's fixed replies. Blocked (listed, or unlisted under
      // defaultPolicy "block") and Ask every time chats never get a message nobody approved.
      const rule = decideSend(config, chat, { isWatching: false })
      if (rule.action === 'block' || isListed(config, 'requireApproval', chat)) return 'skipped'
      const at = Date.parse(msg.date)
      if (Number.isNaN(at)) return 'skipped'
      // R5: away now, not just when it was sent (a catch-up at 09:05 of a message from 08:58 is too late),
      // and the message came in during this same window.
      const now = this.#now()
      const window = awayWindowAt(away, new Date(now))
      if (!window || at < window.start.getTime()) return 'skipped'
      if (now - at > AWAY_MAX_AGE_MS) return 'skipped'
      const replied = this.#repliedMap()
      const prev = replied.get(chat.id)
      if (prev !== undefined && prev >= window.start.getTime()) return 'skipped' // R6
      const lastOut = this.#lastOutgoing.get(chat.id)
      if (away.quietMinutes > 0 && lastOut !== undefined && now - lastOut < away.quietMinutes * 60_000) return 'skipped' // R7
      if (this.d.hub.takeoverOf(chat.id) !== null) return 'skipped' // R8
      if (this.d.hub.handledLive(chat.id) && isListed(config, 'autoReply', chat)) return 'skipped'
      if (paged || this.d.pages().some(p => p.senderKey === String(msg.from?.id ?? chat.id))) return 'skipped' // R9
      // R10: a nightly limit, whoever writes. Counted from the saved replies, so a restart doesn't reset it.
      const start = window.start.getTime()
      let tonight = 0
      for (const t of replied.values()) if (t >= start) tonight++
      if (tonight >= AWAY_MAX_PER_WINDOW) {
        if (this.#limitLogged !== window.id) {
          this.#limitLogged = window.id
          this.#log(`away: reached the limit of ${AWAY_MAX_PER_WINDOW} replies tonight; no more until the next away window`)
        }
        return 'skipped'
      }

      // Mark before the first await so a second message arriving meanwhile sees it.
      replied.set(chat.id, now)
      this.#save()
      const text = this.#text(config)
      try {
        const sent = await this.d.tg.sendText(chat.id, text)
        this.d.record({ chatId: chat.id, chatLabel: chat.name, text, messageId: sent.id, via: 'away', sessionLabel: null })
        this.#log(`away reply to ${chat.id}`)
        return 'sent'
      } catch (e) {
        // Restore what was there, unless something else has written this chat since.
        if (replied.get(chat.id) === now) {
          if (prev === undefined) replied.delete(chat.id)
          else replied.set(chat.id, prev)
          this.#save()
        }
        throw e
      }
    } catch (e) {
      this.#log(`away: ${e instanceof Error ? e.message : String(e)}`)
      return 'skipped'
    }
  }

  noteOutgoing(chatId: number, at: number = this.#now()) {
    this.#lastOutgoing.set(chatId, at)
  }

  ui(): UiAway {
    return uiAway(this.d.config(), this.d.tg.state().me, new Date(this.#now()))
  }

  summary(): string {
    return awaySummary(this.d.config().away, new Date(this.#now()))
  }
}
