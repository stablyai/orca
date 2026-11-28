import { describe, expect, it } from 'vitest'
import {
  arrangeNewTabMenuItems,
  buildNewTabMenuLayout,
  withNewTabMenuItemHidden
} from './new-tab-menu-layout'

describe('new-tab-menu-layout malformed input handling', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  it('normalizes malformed layouts instead of throwing', () => {
    const malformed = JSON.parse('{"order":"not-an-array","hidden":42}')
    expect(arrangeNewTabMenuItems(items, malformed)).toEqual({
      visible: items,
      hidden: []
    })
    expect(buildNewTabMenuLayout(['b', 'a'], ['c'], malformed)).toEqual({
      order: ['b', 'a', 'c'],
      hidden: ['c']
    })
    expect(withNewTabMenuItemHidden(malformed, 'b', true)).toEqual({
      order: [],
      hidden: ['b']
    })
  })
})
