import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { TabBarItem } from './tab-bar-item-model'
import {
  findPinnedHomeTabId,
  pinnedHomeDropIndicators,
  stripSortableIdsWithoutPinnedHome,
  withBotHomeFirstTabIds,
  withPinnedHomeFirst
} from './pinned-home-tab'

const homeBot = { chatSessionId: 'home-chat' }
const onBotPage = (): typeof homeBot => homeBot
const offBotPage = (): null => null

function chatTab(
  id: string,
  entityId: string,
  extra: Partial<Tab> = {}
): Tab & { contentType: 'agent-session' } {
  return {
    ...extra,
    id,
    entityId,
    groupId: 'group',
    worktreeId: 'folder:bot-home',
    contentType: 'agent-session',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function chatItem(id: string, entityId: string, extra: Partial<Tab> = {}): TabBarItem {
  return {
    type: 'agent-session',
    id,
    unifiedTabId: id,
    isPinned: false,
    data: chatTab(id, entityId, extra)
  }
}

describe('findPinnedHomeTabId', () => {
  it("takes the bot's Home out of the scroller when it leads the order", () => {
    const items = [chatItem('home', 'home-chat'), chatItem('side', 'side-chat')]
    expect(findPinnedHomeTabId(items, onBotPage)).toBe('home')
  })

  it('pins Home when a restored layout or a new tab put other tabs ahead of it', () => {
    const items = [
      chatItem('side-a', 'side-a-chat'),
      chatItem('side-b', 'side-b-chat'),
      chatItem('home', 'home-chat')
    ]
    expect(findPinnedHomeTabId(items, onBotPage)).toBe('home')
  })

  it("asks each chat's own host, so a chat on another host never stands in for Home", () => {
    const items = [
      chatItem('other-host-home', 'home-chat', { executionHostId: 'runtime:other' }),
      chatItem('home', 'home-chat', { executionHostId: 'local' })
    ]
    const localBotOnly = (hostId: Tab['executionHostId']): typeof homeBot | null =>
      hostId === 'local' ? homeBot : null
    expect(findPinnedHomeTabId(items, localBotOnly)).toBe('home')
  })

  it('prefers a published Home over a preview of it, as Home placement does', () => {
    const items = [
      chatItem('preview', 'home-chat', { isPreview: true }),
      chatItem('home', 'home-chat')
    ]
    expect(findPinnedHomeTabId(items, onBotPage)).toBe('home')
  })

  it('pins nothing outside a bot page or with no tabs', () => {
    expect(findPinnedHomeTabId([chatItem('home', 'home-chat')], offBotPage)).toBeNull()
    expect(findPinnedHomeTabId([], onBotPage)).toBeNull()
  })

  it('pins nothing on a strip no bot calls home, even over a chat shaped like Home', () => {
    expect(findPinnedHomeTabId([chatItem('home', 'home-chat')], null)).toBeNull()
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

  // Identity is the contract here: dnd-kit re-renders every tab when its items array changes identity.
  it('keeps the same array when Home already leads or nothing is pinned', () => {
    const leading = ['home', 'a']
    expect(withPinnedHomeFirst(leading, 'home', id)).toBe(leading)
    const plain = ['a', 'b']
    expect(withPinnedHomeFirst(plain, null, id)).toBe(plain)
  })
})

describe('withBotHomeFirstTabIds', () => {
  it('picks the first drawn of twin Homes, as the tab bar does, whatever order the tabs are listed in', () => {
    const groupTabs = [chatTab('home-2', 'home-chat'), chatTab('home-1', 'home-chat')]
    expect(withBotHomeFirstTabIds(['a', 'home-1', 'home-2'], groupTabs, onBotPage)).toEqual([
      'home-1',
      'a',
      'home-2'
    ])
  })

  it("counts the bot's Home first, as the tab bar shows it", () => {
    const groupTabs = [chatTab('side-a', 'side-a-chat'), chatTab('home', 'home-chat')]
    expect(withBotHomeFirstTabIds(['side-a', 'home'], groupTabs, onBotPage)).toEqual([
      'home',
      'side-a'
    ])
    expect(withBotHomeFirstTabIds(['side-a', 'home'], groupTabs, offBotPage)).toEqual([
      'side-a',
      'home'
    ])
  })

  it('hands back the same order, unread, for a group no bot calls home', () => {
    const order = ['side-a', 'home']
    expect(withBotHomeFirstTabIds(order, [chatTab('home', 'home-chat')], null)).toBe(order)
  })
})

describe('stripSortableIdsWithoutPinnedHome', () => {
  it('drops only the pinned Home from the scroller ids', () => {
    expect(stripSortableIdsWithoutPinnedHome(['home', 'a', 'b'], 'home')).toEqual(['a', 'b'])
  })

  it('keeps every id when nothing is pinned', () => {
    expect(stripSortableIdsWithoutPinnedHome(['a', 'b'], null)).toEqual(['a', 'b'])
  })
})

describe('pinnedHomeDropIndicators', () => {
  it("marks a drop after the pinned Home on Home's own right edge", () => {
    const moved = pinnedHomeDropIndicators(new Map([['side-0', 'left']]), 'home', 'side-0')
    expect([...moved]).toEqual([['home', 'right']])
  })

  it('leaves drops elsewhere in the strip on their tab', () => {
    const indicators = new Map([['side-3', 'left' as const]])
    expect([...pinnedHomeDropIndicators(indicators, 'home', 'side-0')]).toEqual([
      ['side-3', 'left']
    ])
    const afterFirst = new Map([['side-0', 'right' as const]])
    expect([...pinnedHomeDropIndicators(afterFirst, 'home', 'side-0')]).toEqual([
      ['side-0', 'right']
    ])
  })

  it('changes nothing when Home is not pinned', () => {
    const indicators = new Map([['side-0', 'left' as const]])
    expect([...pinnedHomeDropIndicators(indicators, null, 'side-0')]).toEqual([['side-0', 'left']])
  })
})
