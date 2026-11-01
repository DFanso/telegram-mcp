import { newId } from './sessions'

export interface PendingSend {
  id: string
  sessionId: string
  chatId: number
  chatLabel: string
  username: string | null
  text: string
  replyTo?: number
  topicId?: number
  parseMode: 'plain' | 'markdown' | 'html'
  reason: string
  createdAt: number
}

/** Messages waiting for a human yes. Bound to the session that drafted them and dropped after a while. */
export class Approvals {
  readonly #items = new Map<string, PendingSend>()

  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  create(p: Omit<PendingSend, 'id' | 'createdAt'>): PendingSend {
    const item = { ...p, id: newId('a_'), createdAt: this.now() }
    this.#items.set(item.id, item)
    return item
  }

  take(id: string, sessionId: string): PendingSend {
    const item = this.#items.get(id)
    if (!item || this.now() - item.createdAt > this.ttlMs) {
      this.#items.delete(id)
      throw new Error(`No pending message with id ${id} (it may have expired; drafts last ${this.ttlMs / 60_000} minutes).`)
    }
    if (item.sessionId !== sessionId) throw new Error(`Pending message ${id} belongs to another session.`)
    this.#items.delete(id)
    return item
  }

  sweep(): void {
    const now = this.now()
    for (const [id, item] of this.#items) if (now - item.createdAt > this.ttlMs) this.#items.delete(id)
  }
}
