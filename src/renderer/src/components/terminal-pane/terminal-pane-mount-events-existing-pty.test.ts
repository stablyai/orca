// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const SOURCE_TAB_ID = 'tab-source'
const TARGET_TAB_ID = 'tab-target'
const WORKTREE_ID = 'folder:split-authority'
const SOURCE_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const TARGET_SOURCE_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const TARGET_LEAF_ID = '33333333-3333-4333-8333-333333333333'
const PTY_ID = 'pty-existing'

const harness = vi.hoisted(() => ({
  state: null as unknown as {
    tabsByWorktree: Record<string, { id: string }[]>
    terminalLayoutsByTabId: Record<string, { ptyIdsByLeafId?: Record<string, string> } | undefined>
    transferAgentPaneAuthority: ReturnType<typeof vi.fn>
  }
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => harness.state }
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  consumePendingWebRuntimeSplitMirrorTelemetry: () => false
}))

vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync: vi.fn()
}))

vi.mock('../terminal/terminal-tab-actions', () => ({
  closeTerminalTab: vi.fn()
}))

vi.mock('./terminal-pane-lifecycle-primitives', () => ({
  recordRuntimeCreatedTerminalPaneSplit: vi.fn(),
  splitPaneWithOneShotStartup: vi.fn()
}))

import { dispatchTerminalPaneSplitRequest } from './terminal-pane-split-request-routing'
import { installTerminalPaneMountEvents } from './terminal-pane-mount-events'

describe('terminal pane mount existing PTY split', () => {
  let dispose: (() => void) | null = null

  beforeEach(() => {
    harness.state = {
      tabsByWorktree: {
        [WORKTREE_ID]: [{ id: SOURCE_TAB_ID }, { id: TARGET_TAB_ID }]
      },
      terminalLayoutsByTabId: {
        [SOURCE_TAB_ID]: { ptyIdsByLeafId: { [SOURCE_LEAF_ID]: PTY_ID } },
        [TARGET_TAB_ID]: {}
      },
      transferAgentPaneAuthority: vi.fn()
    }
  })

  afterEach(() => {
    dispose?.()
    dispose = null
  })

  it('transfers agent authority when a successful split adopts another tab PTY', () => {
    const manager = {
      getNumericIdForLeaf: vi.fn((leafId: string) => (leafId === TARGET_SOURCE_LEAF_ID ? 7 : null)),
      splitPane: vi.fn(() => ({ leafId: TARGET_LEAF_ID }))
    }
    dispose = installTerminalPaneMountEvents({
      manager: manager as never,
      deps: {
        tabId: TARGET_TAB_ID,
        worktreeId: WORKTREE_ID,
        isActive: true,
        managerRef: { current: manager } as never,
        persistLayoutSnapshot: vi.fn(),
        syncCanExpandState: vi.fn(),
        queueResizeAll: vi.fn()
      },
      ptyDeps: {} as never
    })

    dispatchTerminalPaneSplitRequest({
      tabId: TARGET_TAB_ID,
      worktreeId: WORKTREE_ID,
      paneRuntimeId: -1,
      direction: 'vertical',
      sourceLeafId: TARGET_SOURCE_LEAF_ID,
      newLeafId: TARGET_LEAF_ID,
      ptyId: PTY_ID
    })

    expect(manager.splitPane).toHaveBeenCalledWith(7, 'vertical', {
      leafId: TARGET_LEAF_ID,
      ptyId: PTY_ID
    })
    expect(harness.state.transferAgentPaneAuthority).toHaveBeenCalledWith({
      fromPaneKey: `${SOURCE_TAB_ID}:${SOURCE_LEAF_ID}`,
      toPaneKey: `${TARGET_TAB_ID}:${TARGET_LEAF_ID}`,
      ptyId: PTY_ID
    })
  })
})
