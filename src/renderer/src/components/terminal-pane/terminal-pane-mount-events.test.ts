/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { SPLIT_TERMINAL_PANE_EVENT, type SplitTerminalPaneDetail } from '@/constants/terminal'
import { installTerminalPaneMountEvents } from './terminal-pane-mount-events'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/runtime/web-runtime-session', () => ({
  consumePendingWebRuntimeSplitMirrorTelemetry: () => false
}))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
vi.mock('../terminal/terminal-tab-actions', () => ({ closeTerminalTab: vi.fn() }))
vi.mock('./terminal-pane-lifecycle-primitives', () => ({
  splitPaneWithOneShotStartup: vi.fn(),
  recordRuntimeCreatedTerminalPaneSplit: vi.fn()
}))
vi.mock('./terminal-pane-lifecycle-close', () => ({ applyTerminalPaneCloseRequest: vi.fn() }))

const TAB = 'tab-target'
const B = '22222222-2222-4222-8222-222222222222'
const A = '11111111-1111-4111-8111-111111111111'

function mountedManager() {
  const leafToPane = new Map([[B, 7]])
  return {
    getNumericIdForLeaf: vi.fn((leafId: string) => leafToPane.get(leafId) ?? null),
    splitPane: vi.fn(() => ({ id: 8 })),
    splitPaneAroundLeafIds: vi.fn(() => ({ id: 8 }))
  }
}

let uninstall: (() => void) | null = null

function install(manager: ReturnType<typeof mountedManager>): void {
  uninstall = installTerminalPaneMountEvents({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only calls the manager methods stubbed above.
    manager: manager as unknown as PaneManager,
    deps: {
      tabId: TAB,
      worktreeId: 'wt',
      isActive: true,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a ref holding the same stub.
      managerRef: { current: manager as unknown as PaneManager },
      showPaneTitle: vi.fn(),
      persistLayoutSnapshot: vi.fn(),
      syncCanExpandState: vi.fn(),
      queueResizeAll: vi.fn()
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the placement path never reads ptyDeps.
    ptyDeps: {} as never
  })
}

function split(detail: Partial<SplitTerminalPaneDetail>): void {
  window.dispatchEvent(
    new CustomEvent<SplitTerminalPaneDetail>(SPLIT_TERMINAL_PANE_EVENT, {
      detail: { tabId: TAB, worktreeId: 'wt', paneRuntimeId: -1, direction: 'vertical', ...detail }
    })
  )
}

beforeEach(() => {
  uninstall = null
})
afterEach(() => uninstall?.())

describe('split request placement', () => {
  it('places the new pane before its source leaf when asked, with the adopted PTY', () => {
    const manager = mountedManager()
    install(manager)

    split({ sourceLeafId: B, newLeafId: A, ptyId: 'pty-a', placement: 'before' })

    expect(manager.splitPaneAroundLeafIds).toHaveBeenCalledWith([B], 7, 'vertical', {
      leafId: A,
      ptyId: 'pty-a',
      placement: 'before'
    })
    expect(manager.splitPane).not.toHaveBeenCalled()
  })

  it('places it after the source leaf for placement after', () => {
    const manager = mountedManager()
    install(manager)

    split({
      sourceLeafId: B,
      newLeafId: A,
      ptyId: 'pty-a',
      placement: 'after',
      direction: 'horizontal'
    })

    expect(manager.splitPaneAroundLeafIds).toHaveBeenCalledWith([B], 7, 'horizontal', {
      leafId: A,
      ptyId: 'pty-a',
      placement: 'after'
    })
  })

  it('keeps the plain split path when no placement is given', () => {
    const manager = mountedManager()
    install(manager)

    split({ sourceLeafId: B, newLeafId: A, ptyId: 'pty-a' })

    expect(manager.splitPane).toHaveBeenCalledWith(7, 'vertical', { leafId: A, ptyId: 'pty-a' })
    expect(manager.splitPaneAroundLeafIds).not.toHaveBeenCalled()
  })

  it('ignores a request for a leaf the manager already mounts', () => {
    const manager = mountedManager()
    manager.getNumericIdForLeaf.mockImplementation(() => 7)
    install(manager)

    split({ sourceLeafId: B, newLeafId: A, ptyId: 'pty-a', placement: 'after' })

    expect(manager.splitPaneAroundLeafIds).not.toHaveBeenCalled()
    expect(manager.splitPane).not.toHaveBeenCalled()
  })
})
