import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { TabBarItem } from './tab-bar-item-model'
import {
  findPinnedHomeTabId,
  pinnedHomeDropIndicators,
  stripSortableIdsWithoutPinnedHome,
  withPinnedHomeFirst
} from './pinned-home-tab'

const homeBot = { chatSessionId: 'home-chat' }

function chatItem(id: string, entityId: string): TabBarItem {
  return {
    type: 'agent-session',
    id,
    unifiedTabId: id,
    isPinned: false,
    data: { id, entityId, contentType: 'agent-session' } as Tab & { contentType: 'agent-session' }
  } as TabBarItem
}

describe('findPinnedHomeTabId', () => {
  it("takes the bot's Home out of the scroller when it leads the order", () => {
    const items = [chatItem('home', 'home-chat'), chatItem('side', 'side-chat')]
    expect(findPinnedHomeTabId(items, homeBot)).toBe('home')
  })

  it('pins Home when a restored layout or a new tab put other tabs ahead of it', () => {
    const items = [
      chatItem('side-a', 'side-a-chat'),
      chatItem('side-b', 'side-b-chat'),
      chatItem('home', 'home-chat')
    ]
    expect(findPinnedHomeTabId(items, homeBot)).toBe('home')
  })

  it('pins nothing outside a bot page or with no tabs', () => {
    expect(findPinnedHomeTabId([chatItem('home', 'home-chat')], null)).toBeNull()
    expect(findPinnedHomeTabId([], homeBot)).toBeNull()
  })
})

describe('withPinnedHomeFirst', () => {
  const id = (value: string): string => value

  it('moves a Home that other tabs got ahead of to the front, keeping their order', () => {
    expect(withPinnedHomeFirst(['a', 'b', 'home', 'c'], 'home', id)).toEqual([
      'home',
      'a',
      'b',
      'c'
    ])
  })

  it('keeps the same array when Home already leads or nothing is pinned', () => {
    const leading = ['home', 'a']
    expect(withPinnedHomeFirst(leading, 'home', id)).toBe(leading)
    const plain = ['a', 'b']
    expect(withPinnedHomeFirst(plain, null, id)).toBe(plain)
  })
})

describe('stripSortableIdsWithoutPinnedHome', () => {
  it('drops only the pinned Home from the scroller ids', () => {
    expect(stripSortableIdsWithoutPinnedHome(['home', 'a', 'b'], 'home')).toEqual(['a', 'b'])
  })

  it('keeps the same array when nothing is pinned', () => {
    const ids = ['a', 'b']
    expect(stripSortableIdsWithoutPinnedHome(ids, null)).toBe(ids)
  })
})

describe('pinnedHomeDropIndicators', () => {
  it("marks a drop after the pinned Home on Home's own right edge", () => {
    const moved = pinnedHomeDropIndicators(new Map([['side-0', 'left']]), 'home', 'side-0')
    expect([...moved]).toEqual([['home', 'right']])
  })

  it('leaves drops elsewhere in the strip on their tab', () => {
    const indicators = new Map([['side-3', 'left' as const]])
    expect(pinnedHomeDropIndicators(indicators, 'home', 'side-0')).toBe(indicators)
    const afterFirst = new Map([['side-0', 'right' as const]])
    expect(pinnedHomeDropIndicators(afterFirst, 'home', 'side-0')).toBe(afterFirst)
  })

  it('changes nothing when Home is not pinned', () => {
    const indicators = new Map([['side-0', 'left' as const]])
    expect(pinnedHomeDropIndicators(indicators, null, 'side-0')).toBe(indicators)
  })
})
