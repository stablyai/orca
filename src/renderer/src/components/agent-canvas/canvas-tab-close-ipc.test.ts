import { beforeEach, expect, it, vi } from 'vitest'
import {
  useIpcEventsForCloseRouting,
  type CloseActiveTabListener
} from '../../hooks/ipc-events-close-routing-test-harness'

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  vi.doUnmock('@/lib/floating-workspace-terminal-actions')
})

it.each([false, true])(
  'closes only the canvas through the tab shortcut (pinned=%s)',
  async (isPinned) => {
    const closeActiveTabListenerRef: { current: CloseActiveTabListener | null } = { current: null }
    const closeUnifiedTab = vi.fn()
    const closeTab = vi.fn()
    await useIpcEventsForCloseRouting({
      closeActiveTabListenerRef,
      getState: () => ({
        activeWorktreeId: 'workspace',
        activeTabType: 'canvas',
        getActiveTab: () => ({ id: 'canvas', contentType: 'canvas', isPinned }),
        closeUnifiedTab,
        closeTab
      })
    })
    closeActiveTabListenerRef.current?.()
    expect(closeUnifiedTab).toHaveBeenCalledTimes(isPinned ? 0 : 1)
    if (!isPinned) {
      expect(closeUnifiedTab).toHaveBeenCalledWith('canvas')
    }
    expect(closeTab).not.toHaveBeenCalled()
  }
)
