import { describe, expect, it } from 'vitest'
import { botGroupMissing, botGroupPickOrder } from './bot-group-pick'

describe('botGroupPickOrder', () => {
  it('keeps saved members where they were, then adds new picks in pick order', () => {
    expect(botGroupPickOrder(['a', 'b', 'c'], ['b', 'c', 'a'])).toEqual(['a', 'b', 'c'])
    expect(botGroupPickOrder(['a', 'b'], ['e', 'b', 'd'])).toEqual(['b', 'e', 'd'])
  })
})

describe('botGroupMissing', () => {
  it('asks a new group for two bots and an existing room for one', () => {
    expect(botGroupMissing(1, 'Crew', false)).toBe('pickTwo')
    expect(botGroupMissing(1, 'Crew', true)).toBeNull()
    expect(botGroupMissing(0, 'Crew', true)).toBe('pickOne')
    expect(botGroupMissing(2, ' ', false)).toBe('nameIt')
  })
})
