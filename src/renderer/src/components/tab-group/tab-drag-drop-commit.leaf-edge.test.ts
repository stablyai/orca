/**
 * @vitest-environment happy-dom
 */
import type { DragEndEvent } from '@dnd-kit/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'
import { commitTabDragDrop, type LeafJoinDeps } from './tab-drag-drop-commit'
import { getDragPointer } from './tab-drag-pointer'
import type { LeafRect, TabDragLeafTarget } from './tab-drag-leaf-target'
import {
  dragEndEventAt,
  geometrySnapshot,
  GROUP,
  leafRectsFor,
  leafTargetState,
  shownLeafTargetAt,
  SOURCE,
  SOURCE_UNIFIED,
  sourceDrag,
  TARGET,
  TARGET_UNIFIED,
  WT,
  A,
  C,
  sleepingRecord
} from './tab-drag-leaf-target-fixture'

// These cover the window-applied join, which exists only while the layout-owner switch is off.
vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))
vi.mock('../browser-pane/host-guest/webview-registry', () => ({
  acquireWebviewsDragPassthrough: vi.fn(() => vi.fn())
}))
vi.mock('../../runtime/web-runtime-session', () => ({
  isWebRuntimeSessionActive: vi.fn(() => false),
  moveWebRuntimeSessionTab: vi.fn()
}))

const dropAt = dragEndEventAt

function setup(outcome: 'moved' | 'refused' | 'unknown' = 'moved') {
  const moveTabIntoPane = vi.fn<LeafJoinDeps['moveTabIntoPane']>(() => Promise.resolve(outcome))
  const dropUnifiedTab = vi.fn(() => false)
  const reorderUnifiedTabs = vi.fn()
  const finishDrag = vi.fn()
  // What the leaves look like at the drop; the overlay was drawn from the 'split' layout.
  const layout: { dropTime: LeafRect[]; shownTargetOverride?: TabDragLeafTarget | null } = {
    dropTime: leafRectsFor('split')
  }
  let eventPointer = { x: 0, y: 0 }
  const leafJoin: LeafJoinDeps = {
    moveTabIntoPane,
    readLeafRects: () => layout.dropTime,
    getShownLeafTarget: () =>
      layout.shownTargetOverride !== undefined
        ? layout.shownTargetOverride
        : shownLeafTargetAt(eventPointer)
  }
  const commit = (event: DragEndEvent): void => {
    eventPointer = getDragPointer(event) ?? eventPointer
    commitTabDragDrop({
      event,
      worktreeId: WT,
      dragGeometryRef: { current: geometrySnapshot() },
      dropUnifiedTab,
      reorderUnifiedTabs,
      finishDrag,
      leafJoin
    })
  }
  return { commit, layout, moveTabIntoPane, dropUnifiedTab, reorderUnifiedTabs, finishDrag }
}

/** Makes the next move wait, so the test can change the store before the outcome arrives. */
function holdMove(h: ReturnType<typeof setup>): (outcome: 'refused') => void {
  let release: (outcome: 'refused') => void = () => {}
  h.moveTabIntoPane.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve
    })
  )
  return (outcome) => release(outcome)
}

async function settle(release: (outcome: 'refused') => void): Promise<void> {
  release('refused')
  await Promise.resolve()
  await Promise.resolve()
}

function activeIds(): {
  group: string | null | undefined
  global: string | null
  inWorktree?: string | null
} {
  const state = useAppStore.getState()
  return {
    group: shownTabId(),
    global: state.activeTabId,
    inWorktree: state.activeTabIdByWorktree[WT]
  }
}

function selectionRefs() {
  const state = useAppStore.getState()
  return {
    groups: state.groupsByWorktree,
    activeGroupIds: state.activeGroupIdByWorktree,
    activeTabId: state.activeTabId,
    activeTabIds: state.activeTabIdByWorktree
  }
}

function shownTabId(): string | null | undefined {
  return useAppStore.getState().groupsByWorktree[WT]?.[0]?.activeTabId
}

beforeEach(() => {
  // The state the hover preview leaves: the target tab is selected, globally too.
  useAppStore.setState({
    ...leafTargetState(),
    activeGroupIdByWorktree: { [WT]: GROUP },
    activeTabId: TARGET,
    activeTabIdByWorktree: { [WT]: TARGET }
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('commitTabDragDrop: a drop on the edge of a pane inside another tab', () => {
  it.each([
    ['left', { x: 520, y: 316 }, 'left', C],
    ['right', { x: 790, y: 316 }, 'right', C],
    ['top', { x: 650, y: 170 }, 'top', C],
    ['bottom', { x: 650, y: 470 }, 'bottom', C]
  ] as const)('joins on the %s side of the pane it is over', (_name, pointer, side, leafId) => {
    const h = setup()

    h.commit(dropAt(pointer, { overGroupId: GROUP }))

    expect(h.moveTabIntoPane).toHaveBeenCalledTimes(1)
    expect(h.moveTabIntoPane).toHaveBeenCalledWith({
      sourceTabId: SOURCE,
      targetTabId: TARGET,
      targetLeafId: leafId,
      side
    })
    expect(h.dropUnifiedTab).not.toHaveBeenCalled()
    expect(h.reorderUnifiedTabs).not.toHaveBeenCalled()
  })

  it('ends the drag without restoring the preview, so the shown target tab stays shown', async () => {
    const h = setup('moved')

    h.commit(dropAt({ x: 790, y: 316 }, { overGroupId: GROUP }))
    await Promise.resolve()

    expect(h.finishDrag).toHaveBeenCalledTimes(1)
    expect(h.finishDrag).toHaveBeenCalledWith(false)
    expect(shownTabId()).toBe(TARGET_UNIFIED)
  })

  it('changes no tab or focus state when the move was refused', async () => {
    const h = setup('refused')
    const refuse = holdMove(h)

    h.commit(dropAt({ x: 790, y: 316 }, { overGroupId: GROUP }))
    const before = selectionRefs()
    await settle(refuse)

    const after = selectionRefs()
    expect(after.groups).toBe(before.groups)
    expect(after.activeGroupIds).toBe(before.activeGroupIds)
    expect(after.activeTabId).toBe(before.activeTabId)
    expect(after.activeTabIds).toBe(before.activeTabIds)
    expect(activeIds()).toEqual({ group: TARGET_UNIFIED, global: TARGET, inWorktree: TARGET })
  })

  it('leaves no focus or active tab pointing at something gone when the focused group closed before a refusal', async () => {
    const h = setup('refused')
    const refuse = holdMove(h)

    h.commit(dropAt({ x: 790, y: 316 }, { overGroupId: GROUP }))
    // The group focused at drag start loses its last tab; another group takes over.
    const survivor = {
      id: 'group-2',
      worktreeId: WT,
      activeTabId: 'unified-kept',
      tabOrder: ['unified-kept']
    }
    useAppStore.setState({
      groupsByWorktree: { [WT]: [survivor] },
      activeGroupIdByWorktree: { [WT]: 'group-2' },
      activeTabId: 'kept',
      activeTabIdByWorktree: { [WT]: 'kept' }
    })
    await settle(refuse)

    const state = useAppStore.getState()
    const groups = state.groupsByWorktree[WT] ?? []
    for (const groupId of Object.values(state.activeGroupIdByWorktree)) {
      expect(groups.map((g) => g.id)).toContain(groupId)
    }
    for (const group of groups) {
      expect(group.tabOrder).toContain(group.activeTabId)
    }
    expect(state.activeTabId).toBe('kept')
  })

  it('does not join a different pane when the layout moved under a still pointer after the overlay was drawn', () => {
    const h = setup()
    // Same pointer, but the panes swapped sides: x 790 is now the right edge of B, not C.
    h.layout.dropTime = leafRectsFor('split').map(({ leafId, rect }) => ({
      leafId,
      rect: { ...rect, left: 1000 - rect.left - rect.width }
    }))

    h.commit(dropAt({ x: 790, y: 316 }, { overGroupId: GROUP }))

    expect(h.moveTabIntoPane).not.toHaveBeenCalled()
    expect(h.dropUnifiedTab).not.toHaveBeenCalled()
    expect(h.finishDrag).toHaveBeenCalledWith(true, undefined)
  })

  it('does not join when no overlay was shown', () => {
    const h = setup()
    h.layout.shownTargetOverride = null

    h.commit(dropAt({ x: 790, y: 316 }, { overGroupId: GROUP }))

    expect(h.moveTabIntoPane).not.toHaveBeenCalled()
  })

  it('leaves the shown tab alone when the outcome is unknown: main may have moved it', async () => {
    const h = setup('unknown')

    h.commit(dropAt({ x: 790, y: 316 }, { overGroupId: GROUP }))
    await Promise.resolve()
    await Promise.resolve()

    expect(shownTabId()).toBe(TARGET_UNIFIED)
  })

  it('does nothing, and restores nothing, over a pane that cannot take it', () => {
    useAppStore.setState(
      leafTargetState({
        tabsByWorktree: {
          [WT]: (leafTargetState().tabsByWorktree[WT] ?? []).map((tab) =>
            tab.id === TARGET ? { ...tab, viewMode: 'chat' as const } : tab
          )
        }
      })
    )
    const h = setup()

    h.commit(dropAt({ x: 790, y: 316 }, { overGroupId: GROUP }))

    expect(h.moveTabIntoPane).not.toHaveBeenCalled()
    expect(h.dropUnifiedTab).not.toHaveBeenCalled()
    expect(h.finishDrag).toHaveBeenCalledWith(false)
  })

  it.each([
    ['in the dragged tab group', GROUP],
    ['in another group', 'group-2']
  ])(
    'refuses, and changes nothing, when the source fell asleep after the join was shown (%s)',
    (_name, overGroupId) => {
      // The overlay was drawn while the source could still join; the ref keeps that target.
      const shown = shownLeafTargetAt({ x: 790, y: 316 })
      expect(shown).not.toBeNull()
      const paneKey = `${SOURCE}:${A}`
      useAppStore.setState({
        sleepingAgentSessionsByPaneKey: { [paneKey]: sleepingRecord(paneKey, SOURCE) }
      })
      const h = setup()
      h.layout.shownTargetOverride = shown
      const before = selectionRefs()

      h.commit(dropAt({ x: 790, y: 316 }, { overGroupId }))

      expect(h.moveTabIntoPane).not.toHaveBeenCalled()
      expect(h.dropUnifiedTab).not.toHaveBeenCalled()
      expect(h.reorderUnifiedTabs).not.toHaveBeenCalled()
      expect(h.finishDrag).toHaveBeenCalledTimes(1)
      expect(h.finishDrag).toHaveBeenCalledWith(false)
      const after = selectionRefs()
      expect(after.groups).toBe(before.groups)
      expect(after.activeGroupIds).toBe(before.activeGroupIds)
      expect(after.activeTabId).toBe(before.activeTabId)
      expect(after.activeTabIds).toBe(before.activeTabIds)
    }
  )
})

describe('commitTabDragDrop: drops that keep their behaviour', () => {
  it('the center of a pane still moves the tab into the group under the pointer', () => {
    const h = setup()

    h.commit(dropAt({ x: 600, y: 300 }, { overGroupId: 'group-2' }))

    expect(h.moveTabIntoPane).not.toHaveBeenCalled()
    expect(h.dropUnifiedTab).toHaveBeenCalledWith(SOURCE_UNIFIED, { groupId: 'group-2' })
  })

  it("the center of a pane in the dragged tab's own group does nothing and restores the preview", () => {
    const h = setup()

    h.commit(dropAt({ x: 600, y: 300 }, { overGroupId: GROUP }))

    expect(h.moveTabIntoPane).not.toHaveBeenCalled()
    expect(h.dropUnifiedTab).not.toHaveBeenCalled()
    expect(h.reorderUnifiedTabs).not.toHaveBeenCalled()
    expect(h.finishDrag).toHaveBeenCalledWith(true, undefined)
  })

  it('the outer band still opens a new column', () => {
    const h = setup()

    h.commit(dropAt({ x: 900, y: 316 }, { overGroupId: GROUP }))

    expect(h.moveTabIntoPane).not.toHaveBeenCalled()
    expect(h.dropUnifiedTab).toHaveBeenCalledWith(SOURCE_UNIFIED, {
      groupId: GROUP,
      splitDirection: 'right'
    })
  })

  it('a non-terminal tab never joins a pane', () => {
    const h = setup()

    h.commit(
      dropAt(
        { x: 790, y: 316 },
        { overGroupId: 'group-2', drag: sourceDrag({ tabType: 'editor' }) }
      )
    )

    expect(h.moveTabIntoPane).not.toHaveBeenCalled()
    expect(h.dropUnifiedTab).toHaveBeenCalledWith(SOURCE_UNIFIED, { groupId: 'group-2' })
  })
})
