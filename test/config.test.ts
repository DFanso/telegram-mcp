import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore, isListed, parseConfig, rawId, resolveRef, validateNickname } from '../src/shared/config'

const config = parseConfig(
  JSON.stringify({
    chats: {
      leo: { id: 10, username: 'leo_p', name: 'Leo Perera', aliases: ['lp'] },
      leonardo: { id: 11, username: 'leonardo_s', name: 'Leonardo Silva' },
      kyc: { id: -1004413557834, name: 'KYC', topicId: 246 },
    },
    rules: { blocked: [4243362352], autoSend: ['leo', '@anna_k'], requireApproval: ['kyc'] },
  }),
)

describe('resolveRef', () => {
  test('exact nickname, alias, full name, username, id', () => {
    expect(resolveRef(config, 'leo')).toMatchObject({ kind: 'entry', nickname: 'leo' })
    expect(resolveRef(config, 'LEO ')).toMatchObject({ kind: 'entry', nickname: 'leo' })
    expect(resolveRef(config, 'lp')).toMatchObject({ kind: 'entry', nickname: 'leo' })
    expect(resolveRef(config, 'leonardo silva')).toMatchObject({ kind: 'entry', nickname: 'leonardo' })
    expect(resolveRef(config, '@Leo_P')).toMatchObject({ kind: 'entry', nickname: 'leo' })
    expect(resolveRef(config, '-1004413557834')).toMatchObject({ kind: 'entry', nickname: 'kyc' })
    expect(resolveRef(config, 11)).toMatchObject({ kind: 'entry', nickname: 'leonardo' })
  })

  test('unknowns stay unknown, with suggestions but never a guess', () => {
    const r = resolveRef(config, 'leon')
    expect(r.kind).toBe('unknown')
    if (r.kind === 'unknown') expect(r.suggestions.length).toBe(1)
    const p = resolveRef(config, 'perera')
    expect(p.kind).toBe('unknown')
  })

  test('raw usernames and ids that are not saved', () => {
    expect(resolveRef(config, '@someone')).toEqual({ kind: 'username', username: 'someone' })
    expect(resolveRef(config, '555')).toEqual({ kind: 'id', id: 555 })
    expect(resolveRef(config, 'me')).toEqual({ kind: 'self' })
  })
})

describe('lists', () => {
  test('blocked matches raw ids whatever the marking', () => {
    expect(rawId(-1004243362352)).toBe(4243362352)
    expect(isListed(config, 'blocked', { id: -1004243362352 })).toBe(true)
    expect(isListed(config, 'blocked', { id: 4243362352 })).toBe(true)
  })

  test('allow lists match exactly, by nickname or username', () => {
    expect(isListed(config, 'autoSend', { id: 10 })).toBe(true)
    expect(isListed(config, 'autoSend', { id: 11 })).toBe(false)
    expect(isListed(config, 'autoSend', { id: 99, username: 'Anna_K' })).toBe(true)
  })
})

describe('nicknames', () => {
  test('reject names that read as something else', () => {
    expect(validateNickname('leo')).toBeNull()
    expect(validateNickname('@leo')).not.toBeNull()
    expect(validateNickname('12345')).not.toBeNull()
    expect(validateNickname('me')).not.toBeNull()
    expect(validateNickname('  ')).not.toBeNull()
  })
})

describe('ConfigStore', () => {
  test('creates a default file, keeps unknown keys, re-reads before writing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgmcp-'))
    const path = join(dir, 'config.json')
    const store = new ConfigStore(path)
    expect(store.get().footer).toContain('sᴇɴᴛ ᴠɪᴀ ᴄʟᴀᴜᴅᴇ')

    // A human edits the file directly; the store hasn't reloaded yet.
    const onDisk = JSON.parse(readFileSync(path, 'utf8'))
    onDisk.$comment = 'mine'
    onDisk.rules.autoSend = ['leo']
    writeFileSync(path, JSON.stringify(onDisk))

    store.update(c => {
      c.chats.leo = { id: 10, aliases: [] }
    })
    const after = JSON.parse(readFileSync(path, 'utf8'))
    expect(after.$comment).toBe('mine')
    expect(after.rules.autoSend).toEqual(['leo'])
    expect(after.chats.leo.id).toBe(10)
  })

  test('a broken edit keeps the last good config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgmcp-'))
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({ rules: { blocked: [5] } }))
    const store = new ConfigStore(path)
    writeFileSync(path, '{ not json')
    store.reload()
    expect(store.error()).toContain('invalid')
    expect(store.get().rules.blocked).toEqual([5])
  })
})
