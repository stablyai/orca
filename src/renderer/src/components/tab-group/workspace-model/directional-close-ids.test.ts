import { describe, expect, it } from 'vitest'
import { directionalCloseIds } from './directional-close-ids'

// Stored [a, home, b]; the bar draws the bot's pinned Home first: [home, a, b].
const displayed = ['home', 'a', 'b']
const tabs = [
  { id: 'a', isPinned: false },
  { id: 'home', isPinned: true },
  { id: 'b', isPinned: false }
]

describe('directionalCloseIds', () => {
  it('closes every tab drawn right of Home', () => {
    expect(directionalCloseIds(displayed, tabs, 'home', 'right')).toEqual(['a', 'b'])
  })

  it('closes only what is drawn on that side, never the pinned Home', () => {
    expect(directionalCloseIds(displayed, tabs, 'a', 'right')).toEqual(['b'])
    expect(directionalCloseIds(displayed, tabs, 'b', 'left')).toEqual(['a'])
  })

  it('closes nothing for a tab the order does not hold', () => {
    expect(directionalCloseIds(displayed, tabs, 'gone', 'left')).toEqual([])
  })
})
