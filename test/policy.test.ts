import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../src/shared/config'
import { visibleText } from '../src/daemon/formatting'
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
  test('a file to a watched chat asks, even on autoSend; text does not', () => {
    const watchingFile = { isWatching: true, file: true }
    expect(decideSend(config, { id: 12 }, watchingFile).action).toBe('approve') // autoReply, watched
    expect(decideSend(config, { id: 10 }, watchingFile).action).toBe('approve') // autoSend, watched
    expect(decideSend(config, { id: 10 }, { isWatching: false, file: true }).action).toBe('send') // autoSend, not watched
    expect(decideSend(config, { id: 12 }, { isWatching: true, file: false }).action).toBe('send') // text reply
    // It only ever adds a question: blocked stays blocked.
    expect(decideSend(config, { id: -1005550001111 }, watchingFile).action).toBe('block')
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
  test('in markdown and html the footer reads as typed', () => {
    const odd = '\n\n*by* _me_ <3 & [x](y) ||z|| `c` \\ ~~s~~'
    const plain = `**hi**${odd}`.replace('**hi**', 'hi')
    expect(visibleText(withFooter('**hi**', odd, 'markdown'), 'markdown')).toBe(plain)
    expect(visibleText(withFooter('<b>hi</b>', odd, 'html'), 'html')).toBe(plain)
    // Still once.
    const md = withFooter('hi', odd, 'markdown')
    expect(withFooter(md, odd, 'markdown')).toBe(md)
    // A footer with nothing to escape is the same in every mode.
    expect(withFooter('hi', footer, 'markdown')).toBe(`hi${footer}`)
  })
})
