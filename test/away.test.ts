import { describe, expect, test } from 'bun:test'
import {
  AWAY_DAY_MESSAGE,
  AwaySchema,
  DEFAULT_SCHEDULES,
  applyAwayPatch,
  awaySummary,
  awayWindowAt,
  daysText,
  delayText,
  firstName,
  nextAwayChange,
  parseAwayArgs,
  renderAwayMessage,
  scheduleSummary,
  scheduleWindowAt,
  type AwayConfig,
  type AwaySchedule,
} from '../src/shared/away'

const defaults = AwaySchema.parse({})
const on = { ...defaults, enabled: true }
// November 2026: the 1st is a Sunday, so the 2nd is a Monday and the 7th a Saturday.
const d = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m)
const sched = (over: Partial<AwaySchedule>): AwaySchedule => ({
  id: 'x',
  name: 'X',
  enabled: true,
  from: '18:00',
  until: '09:00',
  days: [0, 1, 2, 3, 4, 5, 6],
  startDate: null,
  endDate: null,
  delaySeconds: 0,
  repeatMinutes: 0,
  message: 'out',
  ...over,
})
const away = (...schedules: AwaySchedule[]): AwayConfig => AwaySchema.parse({ enabled: true, schedules })

describe('the schema', () => {
  test('no away at all gets the day and night schedules', () => {
    expect(defaults.enabled).toBe(false)
    expect(defaults.schedules).toEqual(DEFAULT_SCHEDULES)
    const [day, night] = defaults.schedules
    expect(day).toMatchObject({ from: '08:00', until: '21:00', delaySeconds: 30, message: AWAY_DAY_MESSAGE })
    expect(night).toMatchObject({ from: '21:00', until: '08:00', delaySeconds: 0 })
  })

  test("an earlier build's single window becomes one schedule", () => {
    const a = AwaySchema.parse({ enabled: true, from: '14:00', until: '14:30', message: 'lunch', quietMinutes: 10 })
    expect(a.enabled).toBe(true)
    expect(a.quietMinutes).toBe(10)
    expect(a.schedules).toEqual([sched({ id: 'away', name: 'Away', from: '14:00', until: '14:30', message: 'lunch' })])
    expect('from' in a).toBe(false)
    expect('message' in a).toBe(false)
  })

  test('schedules without an id get one', () => {
    const a = AwaySchema.parse({ schedules: [{ ...sched({}), id: undefined }, sched({ id: 's1' }), { ...sched({}), id: undefined }] })
    expect(a.schedules.map(s => s.id)).toEqual(['s2', 's1', 's3'])
  })

  test('days are sorted and deduplicated; none is refused', () => {
    expect(AwaySchema.parse({ schedules: [sched({ days: [5, 1, 5] })] }).schedules[0]!.days).toEqual([1, 5])
    expect(AwaySchema.safeParse({ schedules: [sched({ days: [] })] }).success).toBe(false)
  })

  test('bad values are refused', () => {
    for (const bad of [
      { from: '24:00' },
      { from: '09:00' },
      { name: ' ' },
      { message: '' },
      { delaySeconds: 601 },
      { repeatMinutes: -1 },
      { startDate: '2026-13-01' },
      { startDate: '2026-12-02', endDate: '2026-12-01' },
    ]) {
      expect(AwaySchema.safeParse({ schedules: [sched(bad)] }).success).toBe(false)
    }
    expect(AwaySchema.safeParse({ schedules: [sched({}), sched({})] }).success).toBe(false) // same id twice
  })
})

describe('scheduleWindowAt', () => {
  test('window crosses midnight', () => {
    const w = { from: '18:00', until: '09:00' }
    expect(scheduleWindowAt(w, d(3, 17, 59))).toBeNull()
    expect(scheduleWindowAt(w, d(3, 18, 0))).toEqual({ id: '2026-11-03T18:00', start: d(3, 18), end: d(4, 9) })
    expect(scheduleWindowAt(w, d(4, 2, 0))?.id).toBe('2026-11-03T18:00')
    expect(scheduleWindowAt(w, d(4, 9, 0))).toBeNull()
    expect(scheduleWindowAt(w, d(4, 8, 59))?.id).toBe('2026-11-03T18:00')
  })

  test('same-day window', () => {
    const w = { from: '13:00', until: '14:00' }
    expect(scheduleWindowAt(w, d(3, 13, 30))).toEqual({ id: '2026-11-03T13:00', start: d(3, 13), end: d(3, 14) })
    expect(scheduleWindowAt(w, d(3, 14, 0))).toBeNull()
    expect(scheduleWindowAt(w, d(3, 12, 59))).toBeNull()
  })

  test('weekdays only: an overnight window belongs to the day it starts', () => {
    const w = { from: '21:00', until: '08:00', days: [1, 2, 3, 4, 5] }
    expect(scheduleWindowAt(w, d(6, 23))).not.toBeNull() // Friday night
    expect(scheduleWindowAt(w, d(7, 3))).not.toBeNull() // early Saturday, still Friday's night
    expect(scheduleWindowAt(w, d(7, 23))).toBeNull() // Saturday night
    expect(scheduleWindowAt(w, d(9, 3))).toBeNull() // early Monday is Sunday's night
  })

  test('dates limit the days it starts on', () => {
    const w = { from: '09:00', until: '17:00', startDate: '2026-11-10', endDate: '2026-11-12' }
    expect(scheduleWindowAt(w, d(9, 10))).toBeNull()
    expect(scheduleWindowAt(w, d(10, 10))).not.toBeNull()
    expect(scheduleWindowAt(w, d(12, 16))).not.toBeNull()
    expect(scheduleWindowAt(w, d(13, 10))).toBeNull()
  })
})

describe('awayWindowAt', () => {
  test('the defaults cover the whole day: daytime until 21:00, then night', () => {
    expect(awayWindowAt(on, d(3, 12))?.schedule.id).toBe('day')
    expect(awayWindowAt(on, d(3, 21))?.schedule.id).toBe('night')
    expect(awayWindowAt(on, d(4, 7, 59))?.id).toBe('night@2026-11-03T21:00')
    expect(awayWindowAt(on, d(4, 8))?.schedule.id).toBe('day')
  })

  test('nothing while away or the schedule is off', () => {
    expect(awayWindowAt(defaults, d(3, 12))).toBeNull()
    expect(awayWindowAt(away(sched({ enabled: false })), d(3, 20))).toBeNull()
  })

  test('the more specific schedule wins: dated first, then the shorter window', () => {
    const day = sched({ id: 'day', from: '08:00', until: '21:00' })
    const lunch = sched({ id: 'lunch', from: '13:00', until: '14:00' })
    const holiday = sched({ id: 'holiday', from: '00:00', until: '23:59', startDate: '2026-11-03', endDate: '2026-11-03' })
    expect(awayWindowAt(away(day, lunch), d(3, 13, 30))?.schedule.id).toBe('lunch')
    expect(awayWindowAt(away(lunch, day), d(3, 13, 30))?.schedule.id).toBe('lunch')
    expect(awayWindowAt(away(day, lunch, holiday), d(3, 13, 30))?.schedule.id).toBe('holiday')
    expect(awayWindowAt(away(day, lunch, holiday), d(4, 13, 30))?.schedule.id).toBe('lunch')
  })
})

describe('nextAwayChange', () => {
  test('one schedule', () => {
    const a = away(sched({}))
    expect(nextAwayChange({ ...a, enabled: false }, d(3, 17))).toBeNull()
    expect(nextAwayChange(a, d(3, 17))).toEqual(d(3, 18))
    expect(nextAwayChange(a, d(3, 20))).toEqual(d(4, 9))
    expect(nextAwayChange(a, d(3, 10))).toEqual(d(3, 18))
  })

  test('hand-overs between schedules count', () => {
    expect(nextAwayChange(on, d(3, 12))).toEqual(d(3, 21))
    expect(nextAwayChange(on, d(3, 22))).toEqual(d(4, 8))
  })

  test('skips days it does not run', () => {
    const a = away(sched({ from: '09:00', until: '17:00', days: [1] }))
    expect(nextAwayChange(a, d(3, 10))).toEqual(d(9, 9)) // Tuesday -> next Monday
    expect(nextAwayChange(away(sched({ enabled: false })), d(3, 10))).toBeNull()
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
  test('days and delays in words', () => {
    expect(daysText([0, 1, 2, 3, 4, 5, 6])).toBe('every day')
    expect(daysText([1, 2, 3, 4, 5])).toBe('weekdays')
    expect(daysText([0, 6])).toBe('weekends')
    expect(daysText([0, 1, 3])).toBe('Mon, Wed, Sun')
    expect(delayText(0)).toBe('replies at once')
    expect(delayText(30)).toBe('waits 30 s for you')
    expect(delayText(120)).toBe('waits 2 min for you')
    expect(scheduleSummary(DEFAULT_SCHEDULES[0]!)).toBe('Daytime 08:00–21:00, every day, waits 30 s for you')
    expect(scheduleSummary(sched({ name: 'Trip', startDate: '2026-12-01', endDate: '2026-12-05', enabled: false }))).toBe(
      'Trip 18:00–09:00, every day, 2026-12-01 to 2026-12-05, replies at once (switched off)',
    )
  })
})

describe('applyAwayPatch', () => {
  test('switches and quiet minutes', () => {
    expect(applyAwayPatch(defaults, { enabled: true })).toEqual({ ok: true, away: { ...defaults, enabled: true } })
    expect(applyAwayPatch(defaults, {})).toEqual({ ok: false, error: 'nothing to change: send enabled, quietMinutes or schedules' })
    expect(applyAwayPatch(defaults, 'x')).toMatchObject({ ok: false })
    expect(applyAwayPatch(defaults, { quietMinutes: -1 }).ok).toBe(false)
    expect(applyAwayPatch(defaults, { bogus: 1 })).toEqual({ ok: false, error: 'unknown setting: bogus' })
  })

  test('schedules replace the list, and a mistake names its schedule', () => {
    const r = applyAwayPatch(defaults, { schedules: [sched({ id: 'trip', name: 'Trip' })] })
    expect(r.ok && r.away.schedules.map(s => s.id)).toEqual(['trip'])
    expect(applyAwayPatch(defaults, { schedules: [] })).toMatchObject({ ok: true })
    const bad = applyAwayPatch(defaults, { schedules: [sched({ name: 'Trip', from: '25:00' })] })
    expect(bad).toEqual({ ok: false, error: 'Trip: from must be a time like 18:00' })
    expect(applyAwayPatch(defaults, { schedules: 'x' }).ok).toBe(false)
  })

  test('from, until and message change the first schedule', () => {
    const r = applyAwayPatch(defaults, { from: '09:00', until: '18:00', message: 'busy' })
    expect(r.ok && r.away.schedules[0]).toMatchObject({ id: 'day', from: '09:00', until: '18:00', message: 'busy' })
    expect(r.ok && r.away.schedules[1]).toEqual(DEFAULT_SCHEDULES[1]!)
    const same = applyAwayPatch(defaults, { from: '21:00' })
    expect(same).toEqual({ ok: false, error: "Daytime: From and until can't be the same time." })
    expect(applyAwayPatch(defaults, { message: '   ' }).ok).toBe(false)
    expect(applyAwayPatch(defaults, { message: 'x'.repeat(1001) }).ok).toBe(false)
    const empty = applyAwayPatch({ ...defaults, schedules: [] }, { from: '13:00', until: '14:00' })
    expect(empty.ok && empty.away.schedules).toMatchObject([{ id: 'away', from: '13:00', until: '14:00' }])
  })
})

describe('awaySummary', () => {
  test('summary', () => {
    expect(awaySummary(defaults, d(3, 20))).toBe('off')
    expect(awaySummary(on, d(3, 20))).toBe('on, Daytime now (until 21:00, waits 30 s for you)')
    expect(awaySummary(on, d(3, 22))).toBe('on, Night now (until 08:00, replies at once)')
    expect(awaySummary(away(sched({ name: 'Evening' })), d(3, 10))).toBe('on, Evening starts at 18:00')
    expect(awaySummary(away(sched({ enabled: false })), d(3, 10))).toBe('on, but no schedule is switched on')
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
