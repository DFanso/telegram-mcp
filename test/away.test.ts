import { describe, expect, test } from 'bun:test'
import {
  AwaySchema,
  applyAwayPatch,
  awaySummary,
  awayWindowAt,
  firstName,
  nextAwayChange,
  parseAwayArgs,
  renderAwayMessage,
} from '../src/shared/away'

const defaults = AwaySchema.parse({})
const on = { ...defaults, enabled: true }
const d = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m)

describe('awayWindowAt', () => {
  test('window crosses midnight', () => {
    const w = { from: '18:00', until: '09:00' }
    expect(awayWindowAt(w, d(3, 17, 59))).toBeNull()
    expect(awayWindowAt(w, d(3, 18, 0))).toEqual({ id: '2026-11-03T18:00', start: d(3, 18), end: d(4, 9) })
    expect(awayWindowAt(w, d(4, 2, 0))?.id).toBe('2026-11-03T18:00')
    expect(awayWindowAt(w, d(4, 9, 0))).toBeNull()
    expect(awayWindowAt(w, d(4, 8, 59))?.id).toBe('2026-11-03T18:00')
  })

  test('same-day window', () => {
    const w = { from: '13:00', until: '14:00' }
    const hit = awayWindowAt(w, d(3, 13, 30))
    expect(hit?.id).toBe('2026-11-03T13:00')
    expect(hit?.end).toEqual(d(3, 14))
    expect(awayWindowAt(w, d(3, 14, 0))).toBeNull()
    expect(awayWindowAt(w, d(3, 12, 59))).toBeNull()
  })
})

describe('nextAwayChange', () => {
  test('next change', () => {
    expect(nextAwayChange(defaults, d(3, 17))).toBeNull()
    expect(nextAwayChange(on, d(3, 17))).toEqual(d(3, 18))
    expect(nextAwayChange(on, d(3, 20))).toEqual(d(4, 9))
    expect(nextAwayChange(on, d(3, 10))).toEqual(d(3, 18))
  })
})

describe('render and names', () => {
  test('render', () => {
    expect(renderAwayMessage('{name} is off. {name}!', 'Chamodh')).toBe('Chamodh is off. Chamodh!')
    expect(renderAwayMessage('{name} is off', null)).toBe('{name} is off')
  })
  test('firstName', () => {
    expect(firstName({ name: 'Chamodh Perera' })).toBe('Chamodh')
    expect(firstName(null)).toBeNull()
    expect(firstName({ name: '  ' })).toBeNull()
  })
})

describe('applyAwayPatch', () => {
  test('patch', () => {
    const r = applyAwayPatch(defaults, { enabled: true })
    expect(r).toEqual({ ok: true, away: { ...defaults, enabled: true } })
    const empty = applyAwayPatch(defaults, {})
    expect(empty).toEqual({ ok: false, error: 'nothing to change: send enabled, from, until, message or quietMinutes' })
    expect(applyAwayPatch(defaults, 'x')).toMatchObject({ ok: false })
    const bad = applyAwayPatch(defaults, { from: '25:00' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('18:00')
    const same = applyAwayPatch(defaults, { from: '09:00' })
    expect(same.ok).toBe(false)
    if (!same.ok) expect(same.error).toContain('same time')
    expect(applyAwayPatch(defaults, { message: '   ' }).ok).toBe(false)
    expect(applyAwayPatch(defaults, { message: 'x'.repeat(1001) }).ok).toBe(false)
    expect(applyAwayPatch(defaults, { quietMinutes: -1 }).ok).toBe(false)
    expect(applyAwayPatch(defaults, { bogus: 1 }).ok).toBe(false)
  })
})

describe('awaySummary', () => {
  test('summary', () => {
    expect(awaySummary(defaults, d(3, 20))).toBe('off')
    expect(awaySummary(on, d(3, 20))).toBe('on, 18:00–09:00 (active now, until 09:00)')
    expect(awaySummary(on, d(3, 10))).toBe('on, 18:00–09:00 (starts at 18:00)')
  })
})

describe('parseAwayArgs', () => {
  test('cli args', () => {
    expect(parseAwayArgs([])).toEqual({ kind: 'show' })
    expect(parseAwayArgs(['on'])).toEqual({ kind: 'patch', patch: { enabled: true } })
    expect(parseAwayArgs(['off'])).toEqual({ kind: 'patch', patch: { enabled: false } })
    expect(parseAwayArgs(['hours', '18:00', '09:00'])).toEqual({ kind: 'patch', patch: { from: '18:00', until: '09:00' } })
    expect(parseAwayArgs(['message', 'Hi', 'there'])).toEqual({ kind: 'patch', patch: { message: 'Hi there' } })
    expect(parseAwayArgs(['quiet', '30'])).toEqual({ kind: 'patch', patch: { quietMinutes: 30 } })
    expect(parseAwayArgs(['hours', '18:00']).kind).toBe('error')
    expect(parseAwayArgs(['nope']).kind).toBe('error')
  })
})
