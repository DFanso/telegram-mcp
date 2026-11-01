import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { Paths } from './paths'

export interface Credentials {
  apiId: number
  apiHash: string
}

/** The folder holds the login session (an auth key for your account), so only you may enter it. */
export function ensureHome(paths: Paths): void {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 })
  chmodSync(paths.home, 0o700)
  for (const f of [paths.session, `${paths.session}-wal`, `${paths.session}-shm`, paths.credentials, paths.token]) {
    if (existsSync(f)) chmodSync(f, 0o600)
  }
}

/** The shared secret for the local HTTP/WebSocket API. Created once, readable only by you. */
export function ensureToken(paths: Paths): string {
  if (existsSync(paths.token)) {
    const t = readFileSync(paths.token, 'utf8').trim()
    if (t) return t
  }
  const token = randomBytes(24).toString('hex')
  writeFileSync(paths.token, `${token}\n`, { mode: 0o600 })
  return token
}

export function readToken(paths: Paths): string | null {
  try {
    return readFileSync(paths.token, 'utf8').trim() || null
  } catch {
    return null
  }
}

/** TELEGRAM_API_ID / TELEGRAM_API_HASH from the environment win; otherwise credentials.json. */
export function loadCredentials(paths: Paths): Credentials | null {
  const envId = Number(process.env.TELEGRAM_API_ID)
  const envHash = process.env.TELEGRAM_API_HASH
  if (envId && envHash) return { apiId: envId, apiHash: envHash }
  try {
    const raw = JSON.parse(readFileSync(paths.credentials, 'utf8')) as { apiId?: unknown; apiHash?: unknown }
    const apiId = Number(raw.apiId)
    if (apiId && typeof raw.apiHash === 'string' && raw.apiHash) return { apiId, apiHash: raw.apiHash }
  } catch {}
  return null
}

export function saveCredentials(paths: Paths, c: Credentials): void {
  writeFileSync(paths.credentials, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 })
}

/** Appends to daemon.log, rolling it to daemon.log.1 past 5 MB. Also echoes to a terminal if there is one. */
export function makeLogger(paths: Paths | null): (msg: string) => void {
  let writes = 0
  return (msg: string) => {
    const line = `${new Date().toISOString()} ${msg}\n`
    if (process.stderr.isTTY || !paths) process.stderr.write(line)
    if (!paths) return
    try {
      if (++writes % 100 === 0 && statSync(paths.log).size > 5 * 1024 * 1024) renameSync(paths.log, `${paths.log}.1`)
      appendFileSync(paths.log, line)
    } catch {}
  }
}
