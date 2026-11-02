import { appendFileSync } from 'node:fs'
import { inRefs, type Config, type PagingConfig } from '../shared/config'
import type { IncomingMessage } from '../shared/protocol'

/**
 * Pages: when something needs a human now, the desktop rings until someone acks, and a bot
 * pushes it to the phone. Only the daemon decides what pages: "/page" from someone on
 * paging.pageFrom, a keyword in a paging.vip chat, or Claude through telegram_page. The reason
 * is shown as text and never acted on, and everything the daemon says back to the sender is
 * fixed text, so a chat cannot make a page do anything but notify.
 */

export type PageSource = 'command' | 'keyword' | 'claude' | 'test'
export type PageState = 'ringing' | 'unanswered' | 'snoozed' | 'acked'
export type PageAction = { kind: 'ack' } | { kind: 'snooze'; minutes: number }
/** Where an ack or snooze came from. */
export type PageActor = 'phone' | 'menubar' | 'tray'

export const SNOOZE_MINUTES = [15, 60] as const

export interface PageInput {
  source: PageSource
  /** Who the rate limit counts against: a user id, or "claude". */
  senderKey: string
  senderName: string
  chatId: number | null
  chatLabel: string | null
  messageId: number | null
  reason: string
}

export interface Page extends PageInput {
  id: string
  createdAt: number
  state: PageState
  /** Tries on the phone so far in this round. */
  tries: number
  /** When the next try (or the end of a snooze) is due. */
  nextAt: number
  /** Bot messages for this page, so an ack anywhere can update them all. */
  botMessages: number[]
  settledBy?: PageActor
}

/** Where pages reach the phone: the user's own bot. */
export interface PageChannel {
  send(page: Page, text: string): Promise<number>
  settle(botMessageId: number, text: string): Promise<void>
}

export interface PagerDeps {
  paging: () => PagingConfig
  /** The account owner's first name, for the fixed texts the sender gets. */
  ownerName: () => string
  channel: () => PageChannel | null
  /** Sends one of the fixed texts back to the chat a page came from. */
  tellSender: (chatId: number, text: string, replyTo: number | null) => Promise<unknown>
  auditPath?: string
  now?: () => number
  log?: (msg: string) => void
}

const MAX_REASON = 300
const KEEP_SETTLED = 20

export type PageResult = { ok: true; page: Page } | { ok: false; error: string }

export class Pager {
  #pages = new Map<string, Page>()
  #lastBySender = new Map<string, number>()
  #seq = 0

  constructor(private readonly d: PagerDeps) {}

  get #now() {
    return (this.d.now ?? Date.now)()
  }

  /** Pages that still need someone: ringing, unanswered on the phone, or snoozed. */
  active(): Page[] {
    return [...this.#pages.values()].filter(p => p.state !== 'acked')
  }

  get(id: string): Page | undefined {
    return this.#pages.get(id)
  }

  /** Whether the desktop should be ringing right now. */
  ringing(): boolean {
    return this.active().some(p => p.state === 'ringing' || p.state === 'unanswered')
  }

  async page(input: PageInput): Promise<PageResult> {
    const now = this.#now
    const limits = this.d.paging()
    const last = this.#lastBySender.get(input.senderKey)
    if (input.source !== 'test' && last !== undefined && now - last < limits.perSenderMinutes * 60_000) {
      this.#audit({ event: 'rate_limited', source: input.source, sender: input.senderKey, chatId: input.chatId })
      const wait = Math.ceil((last + limits.perSenderMinutes * 60_000 - now) / 60_000)
      return { ok: false, error: `Already paged in the last ${limits.perSenderMinutes} min; try again in ${wait} min.` }
    }
    this.#lastBySender.set(input.senderKey, now)
    const page: Page = {
      ...input,
      reason: cleanReason(input.reason),
      id: `pg_${now.toString(36)}${(++this.#seq).toString(36)}`,
      createdAt: now,
      state: 'ringing',
      tries: 0,
      nextAt: now,
      botMessages: [],
    }
    this.#pages.set(page.id, page)
    this.#prune()
    this.#audit({ event: 'page', id: page.id, source: page.source, sender: page.senderKey, chatId: page.chatId, reasonLength: page.reason.length })
    if (this.#fromChat(page)) {
      await this.#tell(page, `Paging ${this.d.ownerName()} now. I'll tell you when they've seen it.`)
    }
    await this.#try(page)
    return { ok: true, page }
  }

  /** An ack or snooze from the phone, the menu bar or the tray. False if the page is gone or settled. */
  async act(id: string, action: PageAction, by: PageActor): Promise<boolean> {
    const page = this.#pages.get(id)
    if (!page || page.state === 'acked') return false
    if (action.kind === 'ack') {
      page.state = 'acked'
      page.settledBy = by
      this.#audit({ event: 'ack', id, by })
      await this.#settleBot(page, `✅ Acked from the ${by}.`)
      if (this.#fromChat(page)) await this.#tell(page, `${this.d.ownerName()} saw it.`)
      return true
    }
    const minutes = SNOOZE_MINUTES.includes(action.minutes as 15 | 60) ? action.minutes : 15
    page.state = 'snoozed'
    page.nextAt = this.#now + minutes * 60_000
    this.#audit({ event: 'snooze', id, by, minutes })
    await this.#settleBot(page, `💤 Snoozed for ${minutes} min from the ${by}.`)
    return true
  }

  /** Retries, the end of snoozes, and the close-the-loop message. Called every few seconds. */
  async tick(): Promise<void> {
    const now = this.#now
    const { tries } = this.d.paging()
    for (const page of this.active()) {
      if (page.nextAt > now) continue
      if (page.state === 'snoozed') {
        page.state = 'ringing'
        page.tries = 0
        this.#audit({ event: 'snooze_over', id: page.id })
        await this.#try(page)
      } else if (page.state === 'ringing') {
        if (page.tries < tries) {
          await this.#try(page)
        } else {
          // The desktop keeps ringing; the sender learns nobody has it yet.
          page.state = 'unanswered'
          this.#audit({ event: 'unanswered', id: page.id, tries: page.tries })
          if (this.#fromChat(page)) await this.#tell(page, `${this.d.ownerName()} hasn't seen it yet. Try calling.`)
        }
      }
    }
  }

  async #try(page: Page) {
    const { tries, retryMinutes } = this.d.paging()
    page.tries++
    page.nextAt = this.#now + retryMinutes * 60_000
    const channel = this.d.channel()
    if (!channel) return
    try {
      page.botMessages.push(await channel.send(page, phoneText(page, tries)))
      this.#audit({ event: 'delivered', id: page.id, try: page.tries })
    } catch (e) {
      this.#audit({ event: 'delivery_failed', id: page.id, try: page.tries })
      this.d.log?.(`page ${page.id}: the bot could not reach the phone: ${e instanceof Error ? e.message : e}`)
    }
  }

  async #settleBot(page: Page, text: string) {
    const channel = this.d.channel()
    if (!channel) return
    for (const m of page.botMessages) await channel.settle(m, text).catch(() => {})
  }

  #fromChat(page: Page): page is Page & { chatId: number } {
    return (page.source === 'command' || page.source === 'keyword') && page.chatId !== null
  }

  async #tell(page: Page & { chatId: number }, text: string) {
    try {
      await this.d.tellSender(page.chatId, text, page.messageId)
    } catch (e) {
      this.d.log?.(`page ${page.id}: could not answer the sender: ${e instanceof Error ? e.message : e}`)
    }
  }

  #prune() {
    const settled = [...this.#pages.values()].filter(p => p.state === 'acked')
    for (const p of settled.slice(0, Math.max(0, settled.length - KEEP_SETTLED))) this.#pages.delete(p.id)
  }

  #audit(entry: Record<string, unknown>) {
    if (!this.d.auditPath) return
    try {
      appendFileSync(this.d.auditPath, `${JSON.stringify({ at: new Date(this.#now).toISOString(), ...entry })}\n`, { mode: 0o600 })
    } catch {}
  }
}

/** What reaches the phone. Plain text: the bot sends it with no parse mode. */
export function phoneText(page: Page, tries: number): string {
  const from = page.source === 'claude' ? `Claude (${page.senderName})` : page.senderName
  return [
    `📟 PAGE from ${from}`,
    page.chatLabel ? `Chat: ${page.chatLabel}${page.messageId ? `, message #${page.messageId}` : ''}` : null,
    page.reason || '(no reason given)',
    `Try ${page.tries} of ${tries}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/** The reason is shown, never acted on: one paragraph of plain text, bounded. */
export function cleanReason(text: string): string {
  const flat = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, '').trim()
  return flat.length > MAX_REASON ? `${flat.slice(0, MAX_REASON - 1)}…` : flat
}

/**
 * Whether an incoming message pages: "/page <reason>" from someone on pageFrom, or a keyword
 * in a VIP chat. Your own messages never page.
 */
export function pageTrigger(config: Config, msg: IncomingMessage): { source: 'command' | 'keyword'; reason: string } | null {
  if (msg.outgoing || !msg.from) return null
  const paging = config.paging
  const cmd = /^\/page(?:@\S+)?(?:\s+([\s\S]*))?$/i.exec(msg.text.trim())
  if (cmd) return paging.pageFrom.includes(msg.from.id) ? { source: 'command', reason: cmd[1] ?? '' } : null
  if (!paging.keywords.length || !inRefs(config, paging.vip, msg.chat)) return null
  const words = paging.keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`(^|[^\\p{L}\\p{N}])(${words.join('|')})(?![\\p{L}\\p{N}])`, 'iu').test(msg.text)
    ? { source: 'keyword', reason: msg.text }
    : null
}
