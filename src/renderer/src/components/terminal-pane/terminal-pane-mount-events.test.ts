// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { EQUALIZE_TERMINAL_PANES_EVENT } from '@/constants/terminal'
import { installTerminalPaneMountEvents } from './terminal-pane-mount-events'

function createMountEventsDeps(tabId: string, equalizePaneSizes: () => void) {
  const manager = {
    equalizePaneSizes,
    getNumericIdForLeaf: vi.fn(() => null),
    getPanes: vi.fn(() => [])
  }
  const managerRef = { current: manager }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test double provides only the equalizePaneSizes and pane lookup methods used by mount events.
    manager: manager as never,
    deps: {
      tabId,
      worktreeId: 'wt-1',
      isActive: true,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test double provides only the managerRef wrapper used by mount events.
      managerRef: managerRef as never,
      persistLayoutSnapshot: vi.fn(),
      syncCanExpandState: vi.fn(),
      queueResizeAll: vi.fn()
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: PTY dependencies are unused by equalize events.
    ptyDeps: {} as never
  }
}

describe('terminal-pane-mount-events equalize', () => {
  it('calls manager.equalizePaneSizes when EQUALIZE_TERMINAL_PANES_EVENT matches tabId', () => {
    const tabId = 'tab-target'
    const equalizePaneSizes = vi.fn()
    const cleanup = installTerminalPaneMountEvents(createMountEventsDeps(tabId, equalizePaneSizes))

    window.dispatchEvent(
      new CustomEvent(EQUALIZE_TERMINAL_PANES_EVENT, {
        detail: { tabId }
      })
    )

    expect(equalizePaneSizes).toHaveBeenCalledTimes(1)

    cleanup()
  })

  it('ignores EQUALIZE_TERMINAL_PANES_EVENT for a different tabId', () => {
    const tabId = 'tab-target'
    const equalizePaneSizes = vi.fn()
    const cleanup = installTerminalPaneMountEvents(createMountEventsDeps(tabId, equalizePaneSizes))

    window.dispatchEvent(
      new CustomEvent(EQUALIZE_TERMINAL_PANES_EVENT, {
        detail: { tabId: 'tab-other' }
      })
    )

    expect(equalizePaneSizes).not.toHaveBeenCalled()

    cleanup()
  })

  it('stops listening after cleanup', () => {
    const tabId = 'tab-target'
    const equalizePaneSizes = vi.fn()
    const cleanup = installTerminalPaneMountEvents(createMountEventsDeps(tabId, equalizePaneSizes))

    cleanup()

    window.dispatchEvent(
      new CustomEvent(EQUALIZE_TERMINAL_PANES_EVENT, {
        detail: { tabId }
      })
    )

    expect(equalizePaneSizes).not.toHaveBeenCalled()
  })
})
