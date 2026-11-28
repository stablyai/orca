import { describe, expect, it } from 'vitest'
import type { TabBarItem } from '../model/tab-bar-item-model'
import type { DropIndicator } from './drop-indicator'
import {
  newTabButtonHideClassName,
  resolveRenderedTabStrip,
  stripSizeClassName
} from './rendered-tab-strip'

function item(id: string): TabBarItem {
  return {
    type: 'agent-session',
    id,
    unifiedTabId: id,
    isPinned: false,
    data: {
      id,
      entityId: id,
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
}

function projection(
  ids: string[],
  indicators: [string, DropIndicator][] = []
): Parameters<typeof resolveRenderedTabStrip>[0]['itemProjection'] {
  return { orderedItems: ids.map(item), dropIndicatorByVisibleId: new Map(indicators) }
}

function strip(ids: string[], pinned: string[]): ReturnType<typeof resolveRenderedTabStrip> {
  return resolveRenderedTabStrip({
    itemProjection: projection(ids),
    pinnedSortableIds: pinned,
    stripSortableIds: ids.filter((id) => !pinned.includes(id)),
    clientHostedBrowserRows: []
  })
}

describe('resolveRenderedTabStrip', () => {
  it('keeps the pinned Home out of the scrolling strip and marks a drop before the first strip tab on Home', () => {
    const resolved = resolveRenderedTabStrip({
      itemProjection: projection(['home', 'a', 'b'], [['a', 'left']]),
      pinnedSortableIds: ['home'],
      stripSortableIds: ['a', 'b'],
      clientHostedBrowserRows: []
    })
    expect(resolved.sortableIds).toEqual(['a', 'b'])
    expect(resolved.pinnedCount).toBe(1)
    expect(resolved.stripHasTabs).toBe(true)
    expect([...resolved.dropIndicatorByVisibleId]).toEqual([['home', 'right']])
  })

  it('reports an empty strip beside a lone Home', () => {
    expect(strip(['home'], ['home']).stripHasTabs).toBe(false)
  })
})

describe('newTabButtonHideClassName', () => {
  it('keeps "+" in an empty group', () => {
    expect(newTabButtonHideClassName(strip([], []))).toBe('')
  })

  it('hides "+" 40px earlier beside a pinned Home with other tabs', () => {
    expect(newTabButtonHideClassName(strip(['a'], []))).toBe('@max-[86px]/tab-strip:hidden')
    expect(newTabButtonHideClassName(strip(['home'], ['home']))).toBe(
      '@max-[86px]/tab-strip:hidden'
    )
    expect(newTabButtonHideClassName(strip(['home', 'a'], ['home']))).toBe(
      '@max-[126px]/tab-strip:hidden'
    )
  })
})

describe('stripSizeClassName', () => {
  it('lets the strip give way first beside a pinned Home and drops its floor when empty', () => {
    expect(stripSizeClassName(strip(['a'], []))).toBe('shrink min-w-10')
    expect(stripSizeClassName(strip(['home', 'a'], ['home']))).toBe('shrink-[10000] min-w-10')
    expect(stripSizeClassName(strip(['home'], ['home']))).toBe('shrink-[10000] min-w-0')
  })
})
