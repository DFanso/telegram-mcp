// Away windows across daylight saving changes. The schedules are wall-clock times on this PC, so a
// night that gains or loses an hour still runs from its "from" to its "until" as the clock shows them.
const previousTz = process.env.TZ
process.env.TZ = 'America/New_York'

import { afterAll, describe, expect, test } from 'bun:test'
import { AwaySchema, awayWindowAt, nextAwayChange } from '../src/shared/away'

const night = AwaySchema.parse({
  enabled: true,
  schedules: [{ id: 'night', name: 'Night', from: '21:00', until: '08:00', message: 'asleep' }],
})
const hours = (ms: number) => ms / 3_600_000
const local = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`

describe('daylight saving (America/New_York)', () => {
  afterAll(() => {
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  })

  test('the zone took', () => {
    // 2026-07-01 is daylight time there (UTC-4), 2026-12-01 standard time (UTC-5).
    expect(new Date(2026, 6, 1).getTimezoneOffset()).toBe(240)
    expect(new Date(2026, 11, 1).getTimezoneOffset()).toBe(300)
  })

  test('the night the clocks go back is 12 hours long and still ends at 08:00', () => {
    // 1 November 2026, 02:00 -> 01:00.
    const w = awayWindowAt(night, new Date(2026, 10, 1, 7, 30))!
    expect(local(w.start)).toBe('2026-10-31 21:00')
    expect(local(w.end)).toBe('2026-11-1 8:00')
    expect(hours(w.end.getTime() - w.start.getTime())).toBe(12)
    expect(local(nextAwayChange(night, new Date(2026, 10, 1, 7, 30))!)).toBe('2026-11-1 8:00')
    expect(awayWindowAt(night, new Date(2026, 10, 1, 8, 0))).toBeNull()
  })

  test('the night the clocks go forward is 10 hours long and still ends at 08:00', () => {
    // 14 March 2027, 02:00 -> 03:00.
    const w = awayWindowAt(night, new Date(2027, 2, 14, 7, 59))!
    expect(local(w.start)).toBe('2027-3-13 21:00')
    expect(local(w.end)).toBe('2027-3-14 8:00')
    expect(hours(w.end.getTime() - w.start.getTime())).toBe(10)
    expect(awayWindowAt(night, new Date(2027, 2, 14, 8, 0))).toBeNull()
  })
})
