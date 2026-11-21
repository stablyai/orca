import { describe, expect, it } from 'vitest'
import { makeTestBotItem } from './bot-item.test-fixture'
import { mergeNamedBotItems } from './bot-item-merge'

describe('mergeNamedBotItems', () => {
  it('replaces, drops and adds only the named items, keeping every other one as it was', () => {
    const one = makeTestBotItem(1, { uid: 'u1' })
    const two = makeTestBotItem(2, { uid: 'u2' })
    const three = makeTestBotItem(3, { uid: 'u3' })
    const previous = { items: [one, two, three], counts: { planned: 3 }, seenEventId: 'e1' }
    const named = {
      items: [
        makeTestBotItem(1, { uid: 'u1', title: 'Renamed' }),
        makeTestBotItem(4, { uid: 'u4' })
      ],
      counts: { planned: 3 },
      seenEventId: 'e1'
    }

    const merged = mergeNamedBotItems(previous, named, ['u1', 'u2', 'u4'])

    // In the host's order: newest activity first, then highest number.
    expect(merged.items.map((item) => [item.uid, item.title])).toEqual([
      ['u4', 'Item 4'],
      ['u3', 'Item 3'],
      ['u1', 'Renamed']
    ])
    expect(merged.items[1]).toBe(three)
    expect(mergeNamedBotItems(previous, { ...named, items: [one, two] }, ['u1', 'u2'])).toBe(
      previous
    )
  })
})
