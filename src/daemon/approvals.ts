import type { OutgoingFile } from '../shared/media'
import type { PeerInfo, ToolResult } from '../shared/protocol'
import { newId } from './sessions'

export interface PendingSend {
  id: string
  sessionId: string
  sessionLabel: string
  chatId: number
  chatLabel: string
  /** Name · @username · id · type, so the person approving sees exactly who it goes to. */
  chatDetail: string
  username: string | null
  /** The message, or the caption when a file goes out. */
  text: string
  file?: OutgoingFile
  asPhoto?: boolean
  replyTo?: number
  topicId?: number
  parseMode: 'plain' | 'markdown' | 'html'
  reason: string
  createdAt: number
  peer: PeerInfo
  /** On neither autoSend nor requireApproval: approving also decides which one it joins. */
  firstTime: boolean
  /** The chat's saved nickname, if it has one. */
  nickname: string | null
  /** What it will be saved as otherwise (the approver can change it). */
  suggestedNickname: string
}

export type Remember = 'autoSend' | 'requireApproval'

export interface DecideOptions {
  remember?: Remember
  nickname?: string
}

export interface Outcome {
  approved: boolean
  result: ToolResult
}

/**
 * Messages waiting for a human yes, from the menu bar, the Claude Code dialog, or the chat.
 * Whoever decides first wins; anyone waiting on the draft hears the outcome.
 */
export class Approvals {
  readonly #items = new Map<string, PendingSend>()
  readonly #waiters = new Map<string, ((o: Outcome) => void)[]>()
  /** Recent outcomes, so a wait that starts just after a decision still gets it. */
  readonly #settled = new Map<string, Outcome>()

  constructor(
    readonly ttlMs = 20 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  create(p: Omit<PendingSend, 'id' | 'createdAt'>): PendingSend {
    const item = { ...p, id: newId('a_'), createdAt: this.now() }
    this.#items.set(item.id, item)
    return item
  }

  list(): PendingSend[] {
    return [...this.#items.values()].filter(i => this.now() - i.createdAt <= this.ttlMs)
  }

  /** Removes and returns the draft. `sessionId` null means any session may decide (the menu bar). */
  take(id: string, sessionId: string | null): PendingSend {
    const item = this.#items.get(id)
    if (!item || this.now() - item.createdAt > this.ttlMs) {
      const done = this.#settled.get(id)
      if (done) throw new Error(`Message ${id} was already ${done.approved ? 'approved' : 'declined'}.`)
      throw new Error(`No pending message with id ${id} (drafts last ${this.ttlMs / 60_000} minutes).`)
    }
    if (sessionId !== null && item.sessionId !== sessionId) throw new Error(`Pending message ${id} belongs to another session.`)
    this.#items.delete(id)
    return item
  }

  settle(id: string, outcome: Outcome): void {
    this.#settled.set(id, outcome)
    if (this.#settled.size > 100) this.#settled.delete(this.#settled.keys().next().value!)
    for (const wake of this.#waiters.get(id) ?? []) wake(outcome)
    this.#waiters.delete(id)
  }

  /** Resolves when the draft is decided or expires. */
  wait(id: string): Promise<Outcome> {
    const done = this.#settled.get(id)
    if (done) return Promise.resolve(done)
    if (!this.#items.has(id)) {
      return Promise.resolve({ approved: false, result: { text: `No pending message with id ${id}.`, isError: true } })
    }
    return new Promise(resolve => {
      this.#waiters.set(id, [...(this.#waiters.get(id) ?? []), resolve])
    })
  }

  sweep(): void {
    const now = this.now()
    for (const [id, item] of this.#items) {
      if (now - item.createdAt <= this.ttlMs) continue
      this.#items.delete(id)
      this.settle(id, {
        approved: false,
        result: { text: `Nobody approved the message to ${item.chatLabel} within ${this.ttlMs / 60_000} minutes. Nothing was sent.`, isError: true },
      })
    }
  }
}
