import { readFileSync, renameSync, writeFileSync } from 'node:fs'

/** A moderator's "/bots stop": no Claude session on this account speaks in `chatId` (or anywhere) until `until`. */
export interface Pause {
  /** A chat's marked id, or 'all'. */
  scope: number | 'all'
  /** Where the stop was typed, for the owner's note and status. */
  chatLabel: string
  /** When the stop was sent and when it ends (ms). */
  at: number
  until: number
  /** The moderator, by user id and the name Telegram showed. */
  by: number
  byName: string
}

export interface PausesOptions {
  /** pauses.json; absent = memory only. A restart must not lift a pause. */
  path?: string
  now?: () => number
  log?: (msg: string) => void
}

/** The pauses in force. Expired ones drop out on their own; nothing here sends anything. */
export class Pauses {
  #pauses = new Map<number | 'all', Pause>()
  readonly #now: () => number
  readonly #log: (msg: string) => void

  constructor(private readonly o: PausesOptions = {}) {
    this.#now = o.now ?? Date.now
    this.#log = o.log ?? (() => {})
    if (!o.path) return
    try {
      const raw = JSON.parse(readFileSync(o.path, 'utf8')) as { pauses?: Pause[] }
      for (const p of raw.pauses ?? []) {
        if ((p.scope === 'all' || Number.isSafeInteger(p.scope)) && typeof p.until === 'number') this.#pauses.set(p.scope, p)
      }
    } catch {}
  }

  /** The pause that holds for this chat now (its own or 'all', whichever lasts longer), if any. */
  get(chatId: number): Pause | null {
    this.#sweep()
    const own = this.#pauses.get(chatId)
    const all = this.#pauses.get('all')
    if (own && all) return own.until >= all.until ? own : all
    return own ?? all ?? null
  }

  /** Adds or extends a pause. A later stop for the same scope replaces the earlier one. */
  stop(p: Pause): void {
    this.#pauses.set(p.scope, p)
    this.#save()
  }

  /**
   * Lifts pauses that began at or before `before`: one chat's (a chat's /bots resume leaves an 'all'
   * pause in force), or every one ('all'). Returns what was lifted.
   */
  resume(scope: number | 'all', before: number = this.#now()): Pause[] {
    this.#sweep()
    const lifted = [...this.#pauses.values()].filter(p => (scope === 'all' || p.scope === scope) && p.at <= before)
    for (const p of lifted) this.#pauses.delete(p.scope)
    if (lifted.length) this.#save()
    return lifted
  }

  list(): Pause[] {
    this.#sweep()
    return [...this.#pauses.values()].sort((a, b) => a.until - b.until)
  }

  #sweep() {
    const now = this.#now()
    let changed = false
    for (const [k, p] of this.#pauses) {
      if (p.until <= now) {
        this.#pauses.delete(k)
        changed = true
      }
    }
    if (changed) this.#save()
  }

  #save() {
    if (!this.o.path) return
    try {
      const tmp = `${this.o.path}.tmp`
      writeFileSync(tmp, JSON.stringify({ pauses: [...this.#pauses.values()] }, null, 2), { mode: 0o600 })
      renameSync(tmp, this.o.path)
    } catch (e) {
      this.#log(`moderation: could not save pauses: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}
