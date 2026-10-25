// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyConnectionDeps } from './pty-connection-types'
import { installTerminalPaneMountEvents } from './terminal-pane-mount-events'
import {
  _resetTerminalPaneSplitRequestRoutingForTests,
  dispatchTerminalPaneSplitRequest
} from './terminal-pane-split-request-routing'
import {
  _resetLayoutFramePositionForTests,
  beginLayoutFramePositions,
  endLayoutFramePositions,
  layoutFramesFlowing
} from '@/runtime/layout-frame-position'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
const sendLayoutApply = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/layout-apply-send', () => ({
  sendLayoutApply,
  recordLayoutApply: sendLayoutApply
}))
const storeState = vi.hoisted(() => ({ recordFeatureInteraction: () => {} }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))

const SOURCE = '11111111-1111-4111-8111-111111111111'
const NEW = '22222222-2222-4222-8222-222222222222'

function mountedTab(ptyDeps: { startup?: unknown } = {}): {
  manager: PaneManager
  splitPane: ReturnType<typeof vi.fn>
  startups: unknown[]
} {
  const leafById = new Map<number, string>([[1, SOURCE]])
  const startups: unknown[] = []
  const splitPane = vi.fn((_paneId: number, _direction: string, opts?: { leafId?: string }) => {
    // What the new pane's terminal starts with: read while the pane mounts.
    startups.push(ptyDeps.startup ?? null)
    const leafId = opts?.leafId ?? 'window-minted'
    leafById.set(2, leafId)
    return { id: 2, leafId }
  })
  const manager = {
    splitPane,
    getLeafId: (paneId: number) => leafById.get(paneId) ?? null,
    getNumericIdForLeaf: (leafId: string) =>
      [...leafById].find(([, id]) => id === leafId)?.[0] ?? null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the split handler calls only these manager methods.
  return { manager: manager as unknown as PaneManager, splitPane, startups }
}

function install(manager: PaneManager, ptyDeps: { startup?: unknown } = {}): () => void {
  return installTerminalPaneMountEvents({
    manager,
    deps: {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: true,
      managerRef: { current: manager },
      showPaneTitle: vi.fn(),
      persistLayoutSnapshot: vi.fn(),
      syncCanExpandState: vi.fn(),
      queueResizeAll: vi.fn()
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a split reads only `startup` from pty deps.
    ptyDeps: ptyDeps as PtyConnectionDeps
  })
}

describe('a split main asked for, mounted in a layout-owner build', () => {
  afterEach(() => {
    sendLayoutApply.mockReset()
    _resetTerminalPaneSplitRequestRoutingForTests()
    _resetLayoutFramePositionForTests()
  })

  it('mounts the pane under main’s id and records nothing: main already holds it', () => {
    const { manager, splitPane } = mountedTab()
    const uninstall = install(manager)

    dispatchTerminalPaneSplitRequest({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      paneRuntimeId: 1,
      sourceLeafId: SOURCE,
      direction: 'vertical',
      newLeafId: NEW
    })

    expect(splitPane).toHaveBeenCalledWith(1, 'vertical', { leafId: NEW })
    expect(sendLayoutApply).not.toHaveBeenCalled()
    uninstall()
  })

  it('mounts it while the stream is down, the same way', () => {
    beginLayoutFramePositions()
    endLayoutFramePositions()
    expect(layoutFramesFlowing()).toBe(false)
    const { manager, splitPane } = mountedTab()
    const uninstall = install(manager)

    dispatchTerminalPaneSplitRequest({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      paneRuntimeId: 1,
      sourceLeafId: SOURCE,
      direction: 'horizontal',
      newLeafId: NEW
    })

    expect(splitPane).toHaveBeenCalledWith(1, 'horizontal', { leafId: NEW })
    expect(sendLayoutApply).not.toHaveBeenCalled()
    uninstall()
  })
})
