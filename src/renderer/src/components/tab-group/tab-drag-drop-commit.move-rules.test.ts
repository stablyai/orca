/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '@/store/slices/store-test-helpers'
import { useAppStore } from '../../store'
import {
  holdTerminalMoveKeys,
  isTerminalTabMoveInFlight,
  terminalTabMoveKey
} from '../terminal-pane/terminal-leaf-move-guard'
import type { TerminalLeafIntoTabResult } from '../../../../shared/terminal-leaf-move'
import { moveTerminalTabIntoPane } from '../terminal-pane/terminal-tab-into-pane-move'
import { createJoinHarness } from '../terminal-pane/terminal-tab-into-pane-move-harness'
import { commitTabDragDrop, type LeafJoinDeps } from './tab-drag-drop-commit'
import {
  dragEndEventAt,
  geometrySnapshot,
  GROUP,
  leafRectsFor,
  shownLeafTargetAt,
  leafTargetState,
  SOURCE,
  TARGET,
  TARGET_UNIFIED,
  WT
} from './tab-drag-leaf-target-fixture'

// The drop reaches PR2's real move, so its lock and refusal rules apply to a drag as to the menu.
vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))
vi.mock('../browser-pane/host-guest/webview-registry', () => ({
  acquireWebviewsDragPassthrough: vi.fn(() => vi.fn())
}))
vi.mock('../../runtime/web-runtime-session', () => ({
  isWebRuntimeSessionActive: vi.fn(() => false),
  moveWebRuntimeSessionTab: vi.fn()
}))

const DROP = { x: 790, y: 316 }

function dropOnPaneEdge(h: ReturnType<typeof createJoinHarness>) {
  const finishDrag = vi.fn()
  const leafJoin: LeafJoinDeps = {
    moveTabIntoPane: (args) => moveTerminalTabIntoPane(args, h.deps),
    readLeafRects: () => leafRectsFor('split'),
    getShownLeafTarget: () => shownLeafTargetAt(DROP)
  }
  commitTabDragDrop({
    event: dragEndEventAt(DROP, { overGroupId: GROUP }),
    worktreeId: WT,
    dragGeometryRef: { current: geometrySnapshot() },
    dropUnifiedTab: vi.fn(() => false),
    reorderUnifiedTabs: vi.fn(),
    finishDrag,
    leafJoin
  })
  return finishDrag
}

const shownTabId = (): string | null | undefined =>
  useAppStore.getState().groupsByWorktree[WT]?.[0]?.activeTabId

beforeEach(() => {
  useAppStore.setState(leafTargetState())
})

afterEach(() => {
  vi.clearAllMocks()
})

const releases: (() => void)[] = []

afterEach(() => {
  for (const release of releases.splice(0)) {
    release()
  }
})

describe('a pane-edge drop uses the move-into-tab rules', () => {
  it('does not start a join into a tab that is being moved, and ends the drag restoring nothing', () => {
    const h = createJoinHarness(createTestStore())
    releases.push(holdTerminalMoveKeys([terminalTabMoveKey(TARGET)]) ?? (() => {}))

    const finishDrag = dropOnPaneEdge(h)

    expect(h.requests).toHaveLength(0)
    expect(finishDrag).toHaveBeenCalledWith(false)
  })

  it('holds the leaf and both tabs while main works, so a second drop sends nothing', async () => {
    const h = createJoinHarness(createTestStore())
    let answer: (result: TerminalLeafIntoTabResult) => void = () => {}
    h.answerWith(() => new Promise((resolve) => (answer = resolve)))

    dropOnPaneEdge(h)
    dropOnPaneEdge(h)

    expect(h.requests).toHaveLength(1)
    expect(isTerminalTabMoveInFlight(SOURCE)).toBe(true)
    expect(isTerminalTabMoveInFlight(TARGET)).toBe(true)
    expect(shownTabId()).toBe(TARGET_UNIFIED)
    answer({ status: 'refused', reason: 'pty_mismatch' })
    await vi.waitFor(() => expect(isTerminalTabMoveInFlight(TARGET)).toBe(false))
  })

  it('keeps the shown tab when main refuses a frozen workspace', async () => {
    const h = createJoinHarness(createTestStore())
    h.answerWith(() => Promise.resolve({ status: 'refused', reason: 'workspace_frozen' }))

    dropOnPaneEdge(h)

    await vi.waitFor(() => expect(h.requests).toHaveLength(1))
    await Promise.resolve()
    await Promise.resolve()
    expect(shownTabId()).toBe(TARGET_UNIFIED)
    expect(h.calls).toEqual([])
  })
})
