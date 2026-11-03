import { describe, expect, test } from 'bun:test'
import { readersOf } from '../src/daemon/telegram'

describe('readersOf', () => {
  const AT = 1_762_160_000 // seconds, as Telegram sends them
  const ann = { id: 11, displayName: 'Ann', username: 'ann_k' }
  const bob = { id: 22, displayName: 'Bob', username: null }

  test('pairs readers with users by id, whatever order the users come in', () => {
    const r = readersOf([{ userId: 11, date: AT }, { userId: 22, date: AT + 60 }], [bob, ann])
    expect(r.map(x => [x.id, x.name, x.username])).toEqual([[11, 'Ann', 'ann_k'], [22, 'Bob', null]])
    expect(r[1]!.at).toBe(new Date((AT + 60) * 1000).toISOString())
  })

  test("a reader whose user can't be looked up shows as their id, and nobody else's name moves", () => {
    // The first reader isn't in the peer cache: matching by position would have called them Bob.
    const r = readersOf([{ userId: 99, date: AT }, { userId: 22, date: AT }], [null, bob])
    expect(r.map(x => [x.id, x.name])).toEqual([[99, '99'], [22, 'Bob']])
    expect(readersOf([{ userId: 99, date: AT }, { userId: 22, date: AT }], [bob]).map(x => x.name)).toEqual(['99', 'Bob'])
  })
})
