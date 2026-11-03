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
  /** The last try on the phone failed (the bot is set up but could not reach it). */
  deliveryFailed?: boolean
  /** Acked or snoozed at least once: the sender has heard "saw it", and never hears "hasn't seen it". */
  seen: boolean
  /** A try is on its way to the phone, so tick() leaves the page alone. */
  sending: boolean
}

/** Where pages reach the phone: the user's own bot. */
export interface PageChannel {
  /** The bot message id. Throws when the phone can't be reached. */
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
  /** When a rate-limited sender was last told so, to answer each window once rather than every message. */
  #toldLimited = new Map<string, number>()
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

  /** Whether a pager bot is set up, so "the phone wasn't reached" can say why. */
  hasChannel(): boolean {
    return this.d.channel() !== null
  }

  async page(input: PageInput): Promise<PageResult> {
    const now = this.#now
    const limits = this.d.paging()
    const window = limits.perSenderMinutes * 60_000
    const last = this.#lastBySender.get(input.senderKey)
    if (input.source !== 'test' && last !== undefined && now - last < window) {
      this.#audit({ event: 'rate_limited', source: input.source, sender: input.senderKey, chatId: input.chatId })
      const wait = Math.max(1, Math.ceil((last + window - now) / 60_000))
      const told = this.#toldLimited.get(input.senderKey)
      if (input.chatId !== null && isChatSource(input.source) && (told === undefined || told < last)) {
        this.#toldLimited.set(input.senderKey, now)
        await this.#tellChat(input.chatId, input.messageId, `Already paged ${this.d.ownerName()} in the last ${limits.perSenderMinutes} min. Try again in ${wait} min.`)
      }
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
      // Nothing is due until the first try below has gone out, so tick() can't push it twice.
      nextAt: Number.POSITIVE_INFINITY,
      botMessages: [],
      seen: false,
      sending: false,
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
    const firstSeen = !page.seen
    page.seen = true
    if (action.kind === 'ack') {
      page.state = 'acked'
      page.settledBy = by
      // Seen and handled: the sender may page again for the next thing straight away.
      this.#lastBySender.delete(page.senderKey)
      this.#audit({ event: 'ack', id, by })
      await this.#settleBot(page, `✅ Acked from the ${by}.`)
    } else {
      const minutes = SNOOZE_MINUTES.includes(action.minutes as 15 | 60) ? action.minutes : 15
      page.state = 'snoozed'
      page.nextAt = this.#now + minutes * 60_000
      this.#audit({ event: 'snooze', id, by, minutes })
      await this.#settleBot(page, `💤 Snoozed for ${minutes} min from the ${by}.`)
    }
    // A snooze counts as seen too: the sender hears it once, whichever comes first.
    if (firstSeen && this.#fromChat(page)) await this.#tell(page, `${this.d.ownerName()} saw it.`)
    return true
  }

  /** Retries, the end of snoozes, and the close-the-loop message. Called every few seconds. */
  async tick(): Promise<void> {
    const now = this.#now
    const { tries } = this.d.paging()
    for (const page of this.active()) {
      if (page.sending || page.nextAt > now) continue
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
          if (!page.seen && this.#fromChat(page)) await this.#tell(page, `${this.d.ownerName()} hasn't seen it yet. Try calling.`)
        }
      }
    }
  }

  async #try(page: Page) {
    if (page.sending || page.state !== 'ringing') return
    const { tries, retryMinutes } = this.d.paging()
    page.tries++
    page.nextAt = this.#now + retryMinutes * 60_000
    const channel = this.d.channel()
    if (!channel) return
    page.sending = true
    try {
      const sent = await channel.send(page, phoneText(page, tries))
      page.botMessages.push(sent)
      page.deliveryFailed = false
      this.#audit({ event: 'delivered', id: page.id, try: page.tries })
      // Acked or snoozed while it was on its way (the await above lets act() run): settle this one too.
      const after = page.state as PageState
      if (after === 'acked') await channel.settle(sent, `✅ Acked from the ${page.settledBy ?? 'desk'}.`).catch(() => {})
      else if (after === 'snoozed') await channel.settle(sent, '💤 Snoozed.').catch(() => {})
    } catch (e) {
      page.deliveryFailed = true
      this.#audit({ event: 'delivery_failed', id: page.id, try: page.tries })
      this.d.log?.(`page ${page.id}: the bot could not reach the phone: ${e instanceof Error ? e.message : e}`)
    } finally {
      page.sending = false
    }
  }

  async #settleBot(page: Page, text: string) {
    const channel = this.d.channel()
    if (!channel) return
    for (const m of page.botMessages) await channel.settle(m, text).catch(() => {})
  }

  #fromChat(page: Page): page is Page & { chatId: number } {
    return isChatSource(page.source) && page.chatId !== null
  }

  #tell(page: Page & { chatId: number }, text: string) {
    return this.#tellChat(page.chatId, page.messageId, text)
  }

  async #tellChat(chatId: number, replyTo: number | null, text: string) {
    try {
      await this.d.tellSender(chatId, text, replyTo)
    } catch (e) {
      this.d.log?.(`page: could not answer the sender in ${chatId}: ${e instanceof Error ? e.message : e}`)
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

function isChatSource(source: PageSource): boolean {
  return source === 'command' || source === 'keyword'
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

/**
 * The reason is shown, never acted on: one line of plain text, bounded. Controls, newlines and
 * direction marks go; it is cut on whole characters, so an emoji is never split in half.
 */
export function cleanReason(text: string): string {
  const flat = text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = Array.from(flat)
  return chars.length > MAX_REASON ? `${chars.slice(0, MAX_REASON - 1).join('')}…` : flat
}

/**
 * Whether an incoming message pages: "/page <reason>" from someone on pageFrom, or a keyword
 * in a VIP chat. Your own messages never page.
 */
export function pageTrigger(config: Config, msg: IncomingMessage): { source: 'command' | 'keyword'; reason: string } | null {
  if (msg.outgoing || !msg.from) return null
  const paging = config.paging
  const cmd = /^\/page(?:@\S+)?(?:\s+([\s\S]*))?$/i.exec(msg.text.trim())
  if (cmd && paging.pageFrom.includes(msg.from.id)) return { source: 'command', reason: cmd[1] ?? '' }
  // Anyone else's /page is just a message: in a VIP chat its keywords still count.
  if (!paging.keywords.length || !inRefs(config, paging.vip, msg.chat)) return null
  return hasKeyword(msg.text, paging.keywords) ? { source: 'keyword', reason: msg.text } : null
}

/**
 * A keyword as a word of its own: "prod is down" and "URGENT:" page, but "non-urgent", "pre-prod",
 * "prod.example.com" and "prod_db" don't. A full stop only ends a word when nothing follows it.
 */
export function hasKeyword(text: string, keywords: readonly string[]): boolean {
  const words = keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`(?<![\\p{L}\\p{N}_\\-./@])(${words.join('|')})(?![\\p{L}\\p{N}_\\-/@]|\\.[\\p{L}\\p{N}])`, 'iu').test(text)
}
