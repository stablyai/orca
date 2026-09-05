// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyConnectionDeps } from './pty-connection-types'
import { dispatchTerminalPaneSplitRequest } from './terminal-pane-split-request-routing'
import { installTerminalPaneMountEvents } from './terminal-pane-mount-events'

vi.mock('@/runtime/web-runtime-session', () => ({
  consumePendingWebRuntimeSplitMirrorTelemetry: () => false
}))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
vi.mock('../terminal/terminal-tab-actions', () => ({ closeTerminalTab: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))
vi.mock('./terminal-pane-lifecycle-primitives', () => ({
  recordRuntimeCreatedTerminalPaneSplit: vi.fn()
}))

describe('runtime split activation intent', () => {
  it.each([undefined, true, false])('passes activate=%s to pane creation', (activate) => {
    const splitPane = vi.fn(() => ({ id: 2 }))
    const manager = {
      splitPane,
      getNumericIdForLeaf: (leafId: string) => (leafId === 'source' ? 1 : null)
    } as unknown as PaneManager
    const cleanup = installTerminalPaneMountEvents({
      manager,
      deps: {
        tabId: 'tab',
        worktreeId: 'workspace',
        isActive: true,
        managerRef: { current: manager },
        persistLayoutSnapshot: vi.fn(),
        syncCanExpandState: vi.fn(),
        queueResizeAll: vi.fn()
      },
      ptyDeps: {} as PtyConnectionDeps
    })
    try {
      dispatchTerminalPaneSplitRequest({
        tabId: 'tab',
        worktreeId: 'workspace',
        paneRuntimeId: -1,
        sourceLeafId: 'source',
        newLeafId: 'setup',
        ptyId: 'setup-pty',
        direction: 'horizontal',
        ...(activate !== undefined ? { activate } : {})
      })
      expect(splitPane).toHaveBeenCalledExactlyOnceWith(1, 'horizontal', {
        leafId: 'setup',
        ptyId: 'setup-pty',
        ...(activate !== undefined ? { activate } : {})
      })
    } finally {
      cleanup()
    }
  })
})
