/**
 * @vitest-environment happy-dom
 */
import type { DragEndEvent } from '@dnd-kit/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'
import { commitTabDragDrop, type LeafJoinDeps } from './tab-drag-drop-commit'
import { dropTabThroughLayoutOwner } from './tab-group-layout-owner-commands'
import {
  dragEndEventAt,
  geometrySnapshot,
  GROUP,
  leafRectsFor,
  leafTargetState,
  shownLeafTargetAt,
  SOURCE,
  SOURCE_UNIFIED,
  TARGET,
  WT,
  C
} from './tab-drag-leaf-target-fixture'

const switchState = vi.hoisted(() => ({ on: true }))
vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return switchState.on
  }
}))
vi.mock('./tab-group-layout-owner-commands', () => ({
  dropTabThroughLayoutOwner: vi.fn(() => true)
}))
vi.mock('../browser-pane/host-guest/webview-registry', () => ({
  acquireWebviewsDragPassthrough: vi.fn(() => vi.fn())
}))
vi.mock('../../runtime/web-runtime-session', () => ({
  isWebRuntimeSessionActive: vi.fn(() => false),
  moveWebRuntimeSessionTab: vi.fn()
}))

const ownerCommand = vi.mocked(dropTabThroughLayoutOwner)

// The pane edge of T's right pane (x 790) is inside the group's interior; x 900 is the Level 1 band.
const PANE_EDGE = { x: 790, y: 316 }
const OUTER_BAND = { x: 900, y: 316 }

function setup() {
  const moveTabIntoPane = vi.fn<LeafJoinDeps['moveTabIntoPane']>(() => Promise.resolve('moved'))
  const dropUnifiedTab = vi.fn(() => false)
  const finishDrag = vi.fn()
  const leafJoin: LeafJoinDeps = {
    moveTabIntoPane,
    readLeafRects: () => leafRectsFor('split'),
    getShownLeafTarget: () => shownLeafTargetAt(PANE_EDGE)
  }
  const commit = (event: DragEndEvent): void =>
    commitTabDragDrop({
      event,
      worktreeId: WT,
      dragGeometryRef: { current: geometrySnapshot() },
      dropUnifiedTab,
      reorderUnifiedTabs: vi.fn(),
      finishDrag,
      leafJoin
    })
  return { commit, moveTabIntoPane, dropUnifiedTab, finishDrag }
}

beforeEach(() => {
  switchState.on = true
  useAppStore.setState(leafTargetState())
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('commitTabDragDrop on a pane edge in a layout-owner build', () => {
  it('a drop within the shown group starts no join and sends no owner command', () => {
    const h = setup()

    h.commit(dragEndEventAt(PANE_EDGE, { overGroupId: GROUP }))

    expect(h.moveTabIntoPane).not.toHaveBeenCalled()
    expect(ownerCommand).not.toHaveBeenCalled()
    expect(h.dropUnifiedTab).not.toHaveBeenCalled()
    expect(h.finishDrag).toHaveBeenCalledWith(true, undefined)
  })

  it('a drop over another group sends exactly one owner command and starts no join', () => {
    const h = setup()

    h.commit(dragEndEventAt(PANE_EDGE, { overGroupId: 'group-2' }))

    expect(h.moveTabIntoPane).not.toHaveBeenCalled()
    expect(ownerCommand).toHaveBeenCalledTimes(1)
    expect(ownerCommand).toHaveBeenCalledWith(WT, {
      kind: 'move',
      tabId: SOURCE_UNIFIED,
      groupId: 'group-2'
    })
    expect(h.dropUnifiedTab).not.toHaveBeenCalled()
  })

  it('the outer band still splits through the owner', () => {
    const h = setup()

    h.commit(dragEndEventAt(OUTER_BAND, { overGroupId: GROUP }))

    expect(h.moveTabIntoPane).not.toHaveBeenCalled()
    expect(ownerCommand).toHaveBeenCalledTimes(1)
    expect(ownerCommand).toHaveBeenCalledWith(WT, {
      kind: 'split',
      tabId: SOURCE_UNIFIED,
      groupId: GROUP,
      direction: 'right'
    })
  })

  it('the same pane-edge drop joins when the switch is off', () => {
    switchState.on = false
    const h = setup()

    h.commit(dragEndEventAt(PANE_EDGE, { overGroupId: GROUP }))

    expect(h.moveTabIntoPane).toHaveBeenCalledWith({
      sourceTabId: SOURCE,
      targetTabId: TARGET,
      targetLeafId: C,
      side: 'right'
    })
    expect(ownerCommand).not.toHaveBeenCalled()
  })
})
