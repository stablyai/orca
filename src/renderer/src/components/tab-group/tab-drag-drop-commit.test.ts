import type { DragEndEvent } from '@dnd-kit/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabGroup, TabGroupLayoutNode } from '../../../../shared/tab-types'
import type { TabDragItemData } from './tab-drag-data'

type StoreState = {
  groupsByWorktree: Record<string, TabGroup[]>
  layoutByWorktree: Record<string, TabGroupLayoutNode>
}

const storeState = vi.hoisted((): StoreState => ({ groupsByWorktree: {}, layoutByWorktree: {} }))

vi.mock('../../store', () => ({ useAppStore: { getState: () => storeState } }))
vi.mock('../tab-bar/web-runtime-tab-move-mirror', () => ({ mirrorWebRuntimeTabMove: vi.fn() }))

import { commitTabDragDrop } from './tab-drag-drop-commit'
import { makeTabDragEvent } from './tab-drag-event-fixture'
import { getDragPointer, recordTabDragPointer } from './tab-drag-pointer'
import {
  resolveActivePaneColumnSplitTarget,
  type TabGroupPanelGeometrySnapshot
} from './tab-group-panel-split-target'

const WORKTREE_ID = 'wt-1'

/** A DOMRect at the given position and size. */
function rect(left: number, top: number, width: number, height: number): DOMRect {
  const box = {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height
  }
  return { ...box, toJSON: () => box }
}

// Two side-by-side groups: group-1 spans x 281..585, group-2 spans x 591..893.
const geometryEntries = [
  { groupId: 'group-1', panelRect: rect(281, 4, 304, 920), bodyRect: rect(281, 36, 304, 888) },
  { groupId: 'group-2', panelRect: rect(591, 4, 302, 920), bodyRect: rect(591, 36, 302, 888) }
]
const geometry: TabGroupPanelGeometrySnapshot = {
  entries: geometryEntries,
  byGroupId: new Map(geometryEntries.map((entry) => [entry.groupId, entry]))
}

/** Drag data for the dragged tab, which starts in group-3. */
function dragData(overrides: Partial<TabDragItemData> = {}): TabDragItemData {
  return {
    kind: 'tab',
    worktreeId: WORKTREE_ID,
    groupId: 'group-3',
    unifiedTabId: 'tab-dragged',
    visibleTabId: 'tab-dragged',
    tabType: 'terminal',
    label: 'dragged',
    ...overrides
  }
}

/** Drag end whose dnd-kit delta derives `derivedPointer`, as a scrolled source strip makes it. */
function dragEnd(
  derivedPointer: { x: number; y: number },
  overData: Record<string, unknown>
): DragEndEvent {
  return makeTabDragEvent({
    activeData: dragData(),
    overData,
    overRect: { left: 600, width: 100 },
    pointerDown: { x: 1275, y: 19 },
    derivedPointer
  })
}

/** Runs the drop commit and returns the store actions it called. */
function commit(event: DragEndEvent) {
  const dropUnifiedTab = vi.fn(() => true)
  const reorderUnifiedTabs = vi.fn()
  commitTabDragDrop({
    event,
    worktreeId: WORKTREE_ID,
    dragGeometryRef: { current: geometry },
    dropUnifiedTab,
    reorderUnifiedTabs,
    finishDrag: vi.fn()
  })
  return { dropUnifiedTab, reorderUnifiedTabs }
}

beforeEach(() => {
  const group = (id: string, tabOrder: string[]): TabGroup => ({
    id,
    worktreeId: WORKTREE_ID,
    activeTabId: tabOrder[0] ?? null,
    tabOrder
  })
  storeState.groupsByWorktree = {
    [WORKTREE_ID]: [
      group('group-1', ['tab-a']),
      group('group-2', ['tab-b', 'tab-c', 'tab-d']),
      group('group-3', ['tab-dragged', 'tab-e'])
    ]
  }
  storeState.layoutByWorktree = {
    [WORKTREE_ID]: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'group-1' },
      second: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'group-2' },
        second: { type: 'leaf', groupId: 'group-3' }
      }
    }
  }
})

afterEach(() => recordTabDragPointer(null))

describe('commitTabDragDrop with a scrolled source tab strip', () => {
  const paneBody = { kind: 'pane-body', worktreeId: WORKTREE_ID, groupId: 'group-2' }

  it('splits the group under the real cursor, matching the preview', () => {
    // The delta alone derives x=412 (group-1); the cursor is at the bottom of group-2.
    const event = dragEnd({ x: 412, y: 890 }, paneBody)
    recordTabDragPointer({ x: 747, y: 890 })

    const preview = resolveActivePaneColumnSplitTarget({
      event,
      groupsByWorktree: storeState.groupsByWorktree,
      layoutByWorktree: storeState.layoutByWorktree,
      worktreeId: WORKTREE_ID,
      getDragPointer,
      geometry
    })
    expect(preview).toMatchObject({ groupId: 'group-2', zone: 'down' })

    const { dropUnifiedTab } = commit(event)
    expect(dropUnifiedTab).toHaveBeenCalledExactlyOnceWith('tab-dragged', {
      groupId: 'group-2',
      splitDirection: 'down'
    })
  })

  it('inserts on the side of the hovered tab the real cursor is on', () => {
    const overTab = dragData({ groupId: 'group-2', unifiedTabId: 'tab-c', visibleTabId: 'tab-c' })
    // The delta alone derives x=620 (left half of tab-c, which spans 600..700).
    const event = dragEnd({ x: 620, y: 19 }, overTab)

    recordTabDragPointer({ x: 680, y: 19 })
    expect(commit(event).dropUnifiedTab).toHaveBeenCalledExactlyOnceWith('tab-dragged', {
      groupId: 'group-2',
      index: 2
    })

    recordTabDragPointer({ x: 620, y: 19 })
    expect(commit(event).dropUnifiedTab).toHaveBeenCalledExactlyOnceWith('tab-dragged', {
      groupId: 'group-2',
      index: 1
    })
  })

  it('still commits from the delta when no cursor was recorded', () => {
    const { dropUnifiedTab } = commit(dragEnd({ x: 747, y: 890 }, paneBody))
    expect(dropUnifiedTab).toHaveBeenCalledExactlyOnceWith('tab-dragged', {
      groupId: 'group-2',
      splitDirection: 'down'
    })
  })
})
