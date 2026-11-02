import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BunPlatform, SqliteStorage, type ITelegramStorageProvider } from '@mtcute/bun'
import { LogManager } from '@mtcute/bun/utils.js'
import { SessionLockedError, isUnsealed, openSessionStorage, seal, unseal } from '../src/daemon/session-store'
import { getPaths } from '../src/shared/paths'
import { FileSecretStore } from '../src/shared/secrets'

const platform = new BunPlatform()

/** Opens storage the way a TelegramClient does, without a network. */
async function load(s: ITelegramStorageProvider) {
  s.driver.setup?.(new LogManager(undefined, platform), platform)
  await s.driver.load?.()
  return s
}

async function close(s: ITelegramStorageProvider) {
  await s.driver.save?.()
  await s.driver.destroy?.()
}

/** A session.db the way an older version left it: mtcute's own tables, keys unsealed. */
async function legacySession(path: string, keys: Record<number, Uint8Array>) {
  const s = await load(new SqliteStorage(path))
  for (const [dc, key] of Object.entries(keys)) s.authKeys.set(Number(dc), key)
  s.authKeys.setTemp(2, 0, keys[2]!, Math.floor(Date.now() / 1000) + 3600)
  await close(s)
}

function rawRows(path: string) {
  const db = new Database(path)
  try {
    return db.query<{ dc: number; key: Uint8Array }, []>('select dc, key from auth_keys order by dc').all()
  } finally {
    db.close()
  }
}

const setup = () => {
  const paths = getPaths(mkdtempSync(join(tmpdir(), 'tgmcp-session-')))
  return { paths, secrets: new FileSecretStore(paths) }
}

describe('sealing', () => {
  const key = randomBytes(32)
  const authKey = new Uint8Array(randomBytes(256))

  test('round trip', () => {
    const blob = seal(key, authKey, 'auth_keys/2')
    expect(isUnsealed(blob)).toBe(false)
    expect(Buffer.from(blob).includes(Buffer.from(authKey.subarray(0, 32)))).toBe(false)
    expect(unseal(key, blob, 'auth_keys/2')).toEqual(authKey)
  })

  test('the wrong key, or a row moved to another slot, does not open', () => {
    const blob = seal(key, authKey, 'auth_keys/2')
    expect(() => unseal(randomBytes(32), blob, 'auth_keys/2')).toThrow(SessionLockedError)
    expect(() => unseal(key, blob, 'auth_keys/4')).toThrow(SessionLockedError)
  })
})

describe('session.db', () => {
  test('an older unsealed session is sealed in place, and mtcute still gets the same key', async () => {
    const { paths, secrets } = setup()
    const dc2 = new Uint8Array(randomBytes(256))
    const dc4 = new Uint8Array(randomBytes(256))
    await legacySession(paths.session, { 2: dc2, 4: dc4 })
    expect(rawRows(paths.session).map(r => isUnsealed(r.key))).toEqual([true, true])

    const logs: string[] = []
    const s = await load(await openSessionStorage(paths.session, secrets, { log: m => logs.push(m) }))
    expect(s.authKeys.get(2)).toEqual(dc2)
    expect(s.authKeys.get(4)).toEqual(dc4)
    expect(s.authKeys.getTemp(2, 0, Math.floor(Date.now() / 1000))).toEqual(dc2)
    await close(s)

    expect(await secrets.get('session-key')).toBeTruthy()
    expect(logs.join('\n')).toContain('sealed 3 auth key(s)')
    // Nothing on disk holds the key in the clear any more: not the rows, not the file, not the WAL.
    expect(rawRows(paths.session).map(r => isUnsealed(r.key))).toEqual([false, false])
    for (const f of [paths.session, `${paths.session}-wal`]) {
      if (existsSync(f)) expect(readFileSync(f).includes(Buffer.from(dc2.subarray(0, 64)))).toBe(false)
    }
    expect(existsSync(`${paths.session}-wal`) ? statSync(`${paths.session}-wal`).size : 0).toBe(0)
  })

  test('new keys mtcute saves are sealed on the way in', async () => {
    const { paths, secrets } = setup()
    const s = await load(await openSessionStorage(paths.session, secrets))
    const k = new Uint8Array(randomBytes(256))
    s.authKeys.set(1, k)
    expect(s.authKeys.get(1)).toEqual(k)
    await close(s)
    expect(rawRows(paths.session).map(r => isUnsealed(r.key))).toEqual([false])

    const again = await load(await openSessionStorage(paths.session, secrets))
    expect(again.authKeys.get(1)).toEqual(k)
    await close(again)
  })

  test('a sealed session whose key is gone needs a new login; login starts over', async () => {
    const { paths, secrets } = setup()
    const s = await load(await openSessionStorage(paths.session, secrets))
    s.authKeys.set(2, new Uint8Array(randomBytes(256)))
    await close(s)

    await secrets.delete('session-key')
    await expect(openSessionStorage(paths.session, secrets)).rejects.toBeInstanceOf(SessionLockedError)
    // The daemon must not quietly make a new key: that would orphan the sealed login for good.
    expect(await secrets.get('session-key')).toBeNull()

    const fresh = await load(await openSessionStorage(paths.session, secrets, { fresh: true }))
    expect(fresh.authKeys.get(2)).toBeNull()
    await close(fresh)
    expect(await secrets.get('session-key')).toBeTruthy()
  })

  test('a different key in the keystore is refused, not overwritten', async () => {
    const { paths, secrets } = setup()
    const s = await load(await openSessionStorage(paths.session, secrets))
    s.authKeys.set(2, new Uint8Array(randomBytes(256)))
    await close(s)
    await secrets.set('session-key', randomBytes(32).toString('base64'))
    await expect(openSessionStorage(paths.session, secrets)).rejects.toThrow('sealed with a different key')
    expect(rawRows(paths.session)).toHaveLength(1)
  })
})
