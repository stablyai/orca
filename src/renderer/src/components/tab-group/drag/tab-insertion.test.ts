import { describe, expect, it } from 'vitest'
import type { DragMoveEvent } from '@dnd-kit/core'
import { resolveTabInsertion } from './tab-insertion'
import { isTabDragData, type TabDragItemData } from './tab-drag-data'

function tab(id: string, extra: Partial<TabDragItemData> = {}): TabDragItemData {
  return {
    kind: 'tab',
    worktreeId: 'w',
    groupId: 'g',
    unifiedTabId: id,
    visibleTabId: id,
    tabType: 'terminal',
    label: id,
    ...extra
  }
}

// A 200x32 row at (0, 100): its horizontal midpoint is x=100, its vertical midpoint y=116.
function dragOver(over: TabDragItemData): DragMoveEvent {
  const event = {
    active: { data: { current: tab('dragged') } },
    over: {
      data: { current: over },
      rect: { left: 0, top: 100, width: 200, height: 32 }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolveTabInsertion reads only these fields.
  return event as unknown as DragMoveEvent
}

describe('resolveTabInsertion', () => {
  it('splits a strip tab by x and a vertical-list row by y', () => {
    const atTopRight = { x: 190, y: 104 }
    const resolve = (over: TabDragItemData) =>
      resolveTabInsertion(dragOver(over), isTabDragData, () => atTopRight)?.side
    expect(resolve(tab('strip'))).toBe('right')
    expect(resolve(tab('row', { stripOrientation: 'vertical' }))).toBe('left')
  })

  it('never drops above a bot Home row', () => {
    const above = { x: 10, y: 101 }
    const home = tab('home', { stripOrientation: 'vertical', fixedFirst: true })
    expect(resolveTabInsertion(dragOver(home), isTabDragData, () => above)?.side).toBe('right')
  })
})
