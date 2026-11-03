import type { Page, PageAction, PageChannel } from './pager'

/**
 * Your own pager bot (made with @BotFather): it messages you, so a page is a real push on the
 * phone, unlike anything your own account sends you. It talks only to its owner: messages go to
 * the owner's chat, and Ack / Snooze presses from anyone else are ignored. The bot chat must not
 * be muted, or the phone will not buzz.
 */

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/** A Bot API call that hangs must not hold up a page's retries or the ack. */
const CALL_TIMEOUT_MS = 10_000
/** getUpdates long-polls for POLL_SECONDS, so it gets that much longer. */
const POLL_SECONDS = 30

export interface PageBotOptions {
  token: string
  /** The logged-in Telegram account: the only chat the bot talks to. Null until Telegram connects. */
  ownerId: () => number | null
  onAction: (pageId: string, action: PageAction) => void
  log?: (msg: string) => void
  fetch?: Fetch
  api?: string
  /** Tests: how long a call may take (default CALL_TIMEOUT_MS). */
  timeoutMs?: number
}

/** callback_data on the buttons: "<action>:<page id>". */
export function actionButtons(pageId: string) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Ack', callback_data: `ack:${pageId}` },
        { text: '💤 15m', callback_data: `s15:${pageId}` },
        { text: '💤 1h', callback_data: `s60:${pageId}` },
      ],
    ],
  }
}

export function parseButton(data: string): { pageId: string; action: PageAction } | null {
  const m = /^(ack|s15|s60):(pg_[a-z0-9]+)$/.exec(data)
  if (!m) return null
  const action: PageAction = m[1] === 'ack' ? { kind: 'ack' } : { kind: 'snooze', minutes: m[1] === 's15' ? 15 : 60 }
  return { pageId: m[2]!, action }
}

const KEEP_TEXTS = 200

export class PageBot implements PageChannel {
  #offset = 0
  #stopped = false
  #abort: AbortController | null = null
  readonly #fetch: Fetch
  readonly #api: string
  /** What each page message said, so settling it can keep the text and add the outcome. */
  readonly #texts = new Map<number, string>()

  constructor(private readonly o: PageBotOptions) {
    this.#fetch = o.fetch ?? fetch
    this.#api = `${o.api ?? 'https://api.telegram.org'}/bot${o.token}`
  }

  async #call<T>(method: string, body: unknown, o: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const timeout = AbortSignal.timeout(o.timeoutMs ?? this.o.timeoutMs ?? CALL_TIMEOUT_MS)
    const res = await this.#fetch(`${this.#api}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout,
    })
    const data = (await res.json()) as { ok: boolean; result?: T; description?: string }
    // The description never holds the token; the URL does, so it is never logged.
    if (!data.ok) throw new Error(`${method}: ${data.description ?? res.status}`)
    return data.result as T
  }

  async send(page: Page, text: string): Promise<number> {
    const owner = this.o.ownerId()
    if (owner === null) throw new Error('Telegram is not connected yet, so the owner is unknown')
    const m = await this.#call<{ message_id: number }>('sendMessage', {
      chat_id: owner,
      text,
      reply_markup: actionButtons(page.id),
    })
    this.#texts.set(m.message_id, text)
    if (this.#texts.size > KEEP_TEXTS) this.#texts.delete(this.#texts.keys().next().value!)
    return m.message_id
  }

  /**
   * Marks a page message done in place: the buttons go and the outcome is added to its text.
   * An edit doesn't buzz the phone, so acking at the desk doesn't set it off again.
   */
  async settle(botMessageId: number, text: string): Promise<void> {
    const owner = this.o.ownerId()
    if (owner === null) return
    const before = this.#texts.get(botMessageId)
    this.#texts.delete(botMessageId)
    const empty = { inline_keyboard: [] }
    if (before === undefined) {
      await this.#call('editMessageReplyMarkup', { chat_id: owner, message_id: botMessageId, reply_markup: empty })
      return
    }
    await this.#call('editMessageText', { chat_id: owner, message_id: botMessageId, text: `${before}\n\n${text}`, reply_markup: empty })
  }

  /** Who the bot is, to check a token during setup. */
  async me(): Promise<{ id: number; username: string }> {
    return this.#call('getMe', {})
  }

  /** Long-polls for button presses until stop(). */
  start(): void {
    void this.#loop()
  }

  stop(): void {
    this.#stopped = true
    this.#abort?.abort()
  }

  async #loop() {
    let backoff = 1_000
    while (!this.#stopped) {
      this.#abort = new AbortController()
      try {
        const updates = await this.#call<Update[]>(
          'getUpdates',
          { offset: this.#offset, timeout: POLL_SECONDS, allowed_updates: ['callback_query'] },
          { signal: this.#abort.signal, timeoutMs: (POLL_SECONDS + 10) * 1_000 },
        )
        backoff = 1_000
        for (const u of updates) {
          this.#offset = u.update_id + 1
          if (u.callback_query) await this.#press(u.callback_query)
        }
      } catch (e) {
        if (this.#stopped) return
        this.o.log?.(`page bot: ${e instanceof Error ? e.message : e}; retrying`)
        await new Promise(r => setTimeout(r, backoff))
        backoff = Math.min(backoff * 2, 60_000)
      }
    }
  }

  async #press(q: CallbackQuery) {
    const owner = this.o.ownerId()
    const parsed = q.data ? parseButton(q.data) : null
    const mine = owner !== null && q.from.id === owner
    await this.#call('answerCallbackQuery', {
      callback_query_id: q.id,
      text: !mine ? 'This pager is not yours.' : parsed ? 'Got it.' : 'Unknown button.',
    }).catch(() => {})
    if (!mine) {
      this.o.log?.(`page bot: ignored a button press from ${q.from.id}, not the owner`)
      return
    }
    if (parsed) this.o.onAction(parsed.pageId, parsed.action)
  }
}

interface CallbackQuery {
  id: string
  from: { id: number }
  data?: string
}

interface Update {
  update_id: number
  callback_query?: CallbackQuery
}
