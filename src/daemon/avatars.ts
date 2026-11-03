import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** How long a cached photo (or "has none") counts as fresh before it's fetched again. */
export const AVATAR_REFRESH_MS = 24 * 60 * 60_000
/** After a failed fetch, how long that chat isn't tried again (the old photo, if any, is served meanwhile). */
export const AVATAR_RETRY_MS = 10 * 60_000

export interface AvatarOptions {
  dir: string
  /** The chat's small (160×160) profile photo, or null when it has none. Throws when Telegram can't be reached. */
  fetch: (chatId: number) => Promise<Uint8Array | null>
  log?: (msg: string) => void
  now?: () => number
  refreshMs?: number
  retryMs?: number
}

export interface Avatar {
  bytes: Uint8Array
  /** image/jpeg from Telegram; the demo's fixtures are PNG. */
  type: string
  /** Changes when the photo does, for ETag. */
  tag: string
}

function avatar(bytes: Uint8Array): Avatar {
  return { bytes, type: imageType(bytes), tag: createHash('sha1').update(bytes).digest('hex').slice(0, 16) }
}

/** Sniffs the picture type, so the demo's PNGs and Telegram's JPEGs are both labelled right. */
export function imageType(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  return 'image/jpeg'
}

/**
 * Contacts' profile photos for the menu bar and tray avatars. Each one is fetched from Telegram
 * the first time an app asks for it, then kept on disk (`avatars/<chatId>.jpg`, or `<chatId>.none`
 * when the chat has no photo) and fetched again at most once a day. Fetches run one at a time, and
 * asking twice while one is under way waits for it, so the apps' polling never adds Telegram calls.
 */
export class AvatarCache {
  readonly #o: AvatarOptions
  readonly #inflight = new Map<number, Promise<Avatar | null>>()
  readonly #failedAt = new Map<number, number>()
  #queue: Promise<unknown> = Promise.resolve()

  constructor(o: AvatarOptions) {
    this.#o = o
  }

  #now() {
    return this.#o.now?.() ?? Date.now()
  }

  #photoPath(chatId: number) {
    return join(this.#o.dir, `${chatId}.jpg`)
  }

  #nonePath(chatId: number) {
    return join(this.#o.dir, `${chatId}.none`)
  }

  /** What's on disk: the photo, "none" (it has no photo), or nothing yet, and how old it is. */
  #cached(chatId: number): { avatar: Avatar | null; age: number } | null {
    for (const [path, photo] of [[this.#photoPath(chatId), true], [this.#nonePath(chatId), false]] as const) {
      if (!existsSync(path)) continue
      try {
        const age = this.#now() - statSync(path).mtimeMs
        if (!photo) return { avatar: null, age }
        return { avatar: avatar(new Uint8Array(readFileSync(path))), age }
      } catch {
        return null
      }
    }
    return null
  }

  /** The chat's photo, or null when it has none (or it can't be fetched and nothing is cached). */
  async get(chatId: number): Promise<Avatar | null> {
    const cached = this.#cached(chatId)
    if (cached && cached.age < (this.#o.refreshMs ?? AVATAR_REFRESH_MS)) return cached.avatar
    const failed = this.#failedAt.get(chatId)
    if (failed !== undefined && this.#now() - failed < (this.#o.retryMs ?? AVATAR_RETRY_MS)) return cached?.avatar ?? null
    const running = this.#inflight.get(chatId)
    if (running) return running
    const job = this.#queue.then(() => this.#refresh(chatId, cached?.avatar ?? null))
    this.#queue = job.catch(() => {})
    this.#inflight.set(chatId, job)
    try {
      return await job
    } finally {
      this.#inflight.delete(chatId)
    }
  }

  async #refresh(chatId: number, stale: Avatar | null): Promise<Avatar | null> {
    let bytes: Uint8Array | null
    try {
      bytes = await this.#o.fetch(chatId)
    } catch (e) {
      this.#failedAt.set(chatId, this.#now())
      this.#o.log?.(`avatar for ${chatId} not fetched: ${e instanceof Error ? e.message : String(e)}`)
      return stale
    }
    this.#failedAt.delete(chatId)
    try {
      mkdirSync(this.#o.dir, { recursive: true, mode: 0o700 })
      if (!bytes || bytes.length === 0) {
        rmSync(this.#photoPath(chatId), { force: true })
        writeFileSync(this.#nonePath(chatId), '', { mode: 0o600 })
        return null
      }
      // Write beside it and rename, so an app never reads half a picture.
      const path = this.#photoPath(chatId)
      writeFileSync(`${path}.part`, bytes, { mode: 0o600 })
      renameSync(`${path}.part`, path)
      rmSync(this.#nonePath(chatId), { force: true })
    } catch (e) {
      this.#o.log?.(`avatar for ${chatId} not cached: ${e instanceof Error ? e.message : String(e)}`)
    }
    return bytes && bytes.length > 0 ? avatar(bytes) : null
  }
}
