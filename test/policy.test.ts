import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../src/shared/config'
import { decideSend, withFooter } from '../src/shared/policy'

const config = parseConfig(
  JSON.stringify({
    chats: { leo: { id: 10 }, anna: { id: 12 }, both: { id: 13 }, allhands: { id: -1005550001111 } },
    rules: {
      blocked: [5550001111],
      requireApproval: ['both'],
      autoSend: ['leo', 'both', 'allhands'],
      autoReply: ['anna'],
    },
  }),
)
const off = { isWatching: false }

describe('decideSend', () => {
  test('blocked beats everything, even autoSend', () => {
    expect(decideSend(config, { id: -1005550001111 }, off).action).toBe('block')
  })
  test('requireApproval beats autoSend', () => {
    expect(decideSend(config, { id: 13 }, off).action).toBe('approve')
  })
  test('autoSend sends', () => {
    expect(decideSend(config, { id: 10 }, off).action).toBe('send')
  })
  test('autoReply sends only while watching', () => {
    expect(decideSend(config, { id: 12 }, off).action).toBe('approve')
    expect(decideSend(config, { id: 12 }, { isWatching: true }).action).toBe('send')
  })
  test('unlisted chats follow defaultPolicy', () => {
    expect(decideSend(config, { id: 99 }, off).action).toBe('approve')
    const strict = parseConfig(JSON.stringify({ defaultPolicy: 'block' }))
    expect(decideSend(strict, { id: 99 }, off).action).toBe('block')
  })
})

describe('withFooter', () => {
  const footer = '\n\n✨ sᴇɴᴛ ᴠɪᴀ ᴄʟᴀᴜᴅᴇ'
  test('appends once', () => {
    expect(withFooter('hi', footer)).toBe(`hi${footer}`)
    expect(withFooter(`hi${footer}`, footer)).toBe(`hi${footer}`)
    expect(withFooter(`hi\n\n✨ sᴇɴᴛ ᴠɪᴀ ᴄʟᴀᴜᴅᴇ\n`, footer)).toBe(`hi${footer}`)
  })
  test('no footer configured', () => {
    expect(withFooter('hi', '')).toBe('hi')
  })
})
