import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ANNA, FakeTelegram, LEO } from './fake-telegram'

const hhmm = (offsetMs: number) => {
  const d = new Date(Date.now() + offsetMs)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const HOUR = 3_600_000
const settle = () => new Promise(r => setTimeout(r, 30))

async function daemonAway(away: object = { enabled: true, from: hhmm(-HOUR), until: hhmm(HOUR) }) {
  const { createDaemon } = await import('../src/daemon/main')
  const { getPaths } = await import('../src/shared/paths')
  const paths = getPaths(mkdtempSync(join(tmpdir(), 'tgmcp-away-')))
  writeFileSync(paths.config, JSON.stringify({ footer: '', paging: { pageFrom: [ANNA.id] }, away }))
  const tg = new FakeTelegram().add(LEO, ANNA)
  const daemon = await createDaemon({ paths, port: 0, telegram: tg, log: () => {}, pageBotToken: null })
  return { tg, daemon, paths }
}

describe('the away reply in the daemon', () => {
  test('a stranger gets the away reply and it shows in recent', async () => {
    const { tg, daemon } = await daemonAway()
    tg.emit(LEO.id, 'hi')
    await settle()
    expect(tg.sent).toHaveLength(1)
    expect(tg.sent[0]!.text).toContain('off the grid')
    expect(daemon.service.uiState().recent[0]!.via).toBe('away')
    expect(daemon.service.uiState().away).toMatchObject({ enabled: true, active: true })
    // Our own reply is not "you speaking": a second message the same night gets nothing more (R6),
    // and another stranger still gets theirs.
    tg.emit(LEO.id, 'hello?')
    tg.emit(ANNA.id, 'hey')
    await settle()
    expect(tg.sent.map(s => s.chatId)).toEqual([LEO.id, ANNA.id])
    await daemon.stop()
  })

  test('a /page gets the page reply, not the away reply', async () => {
    const { tg, daemon } = await daemonAway()
    tg.emit(ANNA.id, '/page x')
    await settle()
    expect(tg.sent.map(s => s.text)).toEqual(["Paging Me now. I'll tell you when they've seen it."])
    await daemon.stop()
  })

  test('typing on your phone silences it', async () => {
    const { tg, daemon } = await daemonAway()
    tg.emit(LEO.id, 'yo', LEO.id, { outgoing: true })
    await settle()
    tg.emit(LEO.id, 'hi')
    await settle()
    expect(tg.sent).toHaveLength(0)
    await daemon.stop()
  })
})

describe('POST /ui/away', () => {
  const call = (d: { port: number; token: string }, body: unknown, auth = true) =>
    fetch(`http://127.0.0.1:${d.port}/ui/away`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${d.token}` } : {}) },
      body: JSON.stringify(body),
    })

  test('edits the settings, rejects nothing-to-change, and needs the token', async () => {
    const { daemon } = await daemonAway({})
    const ok = await call(daemon, { until: '07:30' })
    expect(ok.status).toBe(200)
    const state = (await (await fetch(`http://127.0.0.1:${daemon.port}/ui/state`, { headers: { authorization: `Bearer ${daemon.token}` } })).json()) as { away: { until: string } }
    expect(state.away.until).toBe('07:30')
    const empty = await call(daemon, {})
    expect(empty.status).toBe(400)
    expect(((await empty.json()) as { text: string }).text).toContain('nothing to change')
    expect((await call(daemon, { until: '07:30' }, false)).status).toBe(401)
    await daemon.stop()
  })
})
