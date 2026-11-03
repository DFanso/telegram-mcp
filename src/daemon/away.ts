import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { AWAY_MAX_AGE_MS, awaySummary, awayWindowAt, firstName, nextAwayChange, renderAwayMessage } from '../shared/away'
import { isListed, type Config } from '../shared/config'
import { withFooter } from '../shared/policy'
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

interface Answered {
  window: string
  chats: number[]
}

/** Sends at most one away reply per chat per away window, to people only, and never over a live Claude or page. */
export class AwayResponder {
  #answered: Answered | null = null
  #lastOutgoing = new Map<number, number>()

  constructor(private d: AwayDeps) {}

  #now = () => (this.d.now ?? Date.now)()
  #log = (m: string) => this.d.log?.(m)

  #text(config: Config): string {
    return withFooter(renderAwayMessage(config.away.message, firstName(this.d.tg.state().me)), config.footer)
  }

  /** The answered set for `window`: loaded lazily from disk, reset when the window differs. */
  #stateFor(window: string): Answered {
    if (!this.#answered && this.d.statePath) {
      try {
        const raw = JSON.parse(readFileSync(this.d.statePath, 'utf8'))
        if (typeof raw?.window === 'string' && Array.isArray(raw.chats)) {
          this.#answered = { window: raw.window, chats: raw.chats.filter((c: unknown) => typeof c === 'number') }
        }
      } catch {}
    }
    if (!this.#answered || this.#answered.window !== window) this.#answered = { window, chats: [] }
    return this.#answered
  }

  #save() {
    if (!this.d.statePath || !this.#answered) return
    try {
      const tmp = `${this.d.statePath}.tmp`
      writeFileSync(tmp, JSON.stringify(this.#answered), { mode: 0o600 })
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
      if (chat.type !== 'user' || chat.isSelf) return 'skipped' // R3 (bots are type 'bot')
      if (isListed(config, 'blocked', chat)) return 'skipped' // R4
      const at = Date.parse(msg.date)
      if (Number.isNaN(at)) return 'skipped'
      const window = awayWindowAt(away, new Date(at)) // R5
      if (!window) return 'skipped'
      const now = this.#now()
      if (now - at > AWAY_MAX_AGE_MS) return 'skipped'
      const state = this.#stateFor(window.id)
      if (state.chats.includes(chat.id)) return 'skipped' // R6
      const lastOut = this.#lastOutgoing.get(chat.id)
      if (away.quietMinutes > 0 && lastOut !== undefined && now - lastOut < away.quietMinutes * 60_000) return 'skipped' // R7
      if (this.d.hub.takeoverOf(chat.id) !== null) return 'skipped' // R8
      if (this.d.hub.handledLive(chat.id) && isListed(config, 'autoReply', chat)) return 'skipped'
      if (paged || this.d.pages().some(p => p.senderKey === String(msg.from?.id ?? chat.id))) return 'skipped' // R9

      // Mark before the first await so a second message arriving meanwhile sees it.
      state.chats.push(chat.id)
      this.#save()
      const text = this.#text(config)
      try {
        const sent = await this.d.tg.sendText(chat.id, text)
        this.d.record({ chatId: chat.id, chatLabel: chat.name, text, messageId: sent.id, via: 'away', sessionLabel: null })
        this.#log(`away reply to ${chat.id}`)
        return 'sent'
      } catch (e) {
        if (this.#answered === state) {
          state.chats = state.chats.filter(c => c !== chat.id)
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
    const config = this.d.config()
    const { away } = config
    const now = new Date(this.#now())
    return {
      enabled: away.enabled,
      from: away.from,
      until: away.until,
      message: away.message,
      quietMinutes: away.quietMinutes,
      active: away.enabled && awayWindowAt(away, now) !== null,
      nextChange: nextAwayChange(away, now)?.toISOString() ?? null,
      preview: this.#text(config),
    }
  }

  summary(): string {
    return awaySummary(this.d.config().away, new Date(this.#now()))
  }
}
