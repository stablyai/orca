import { beforeEach, expect, it, vi } from 'vitest'
import {
  useIpcEventsForCloseRouting,
  type CloseActiveTabListener
} from '../../hooks/ipc-events-close-routing-test-harness'
import type { Tab } from '../../../../shared/tab-types'

const clearContext = vi.fn(async () => {})

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  vi.doUnmock('@/lib/floating-workspace-terminal-actions')
  clearContext.mockReset().mockResolvedValue(undefined)
  vi.doMock('./canvas-context-sync', () => ({ clearClosedCanvasContext: clearContext }))
})

it.each([false, true])(
  'closes only the canvas through the tab shortcut (pinned=%s)',
  async (isPinned) => {
    const closeActiveTabListenerRef: { current: CloseActiveTabListener | null } = { current: null }
    const closeUnifiedTab = vi.fn()
    const closeTab = vi.fn()
    const tab = {
      id: 'canvas',
      contentType: 'canvas',
      worktreeId: 'workspace',
      executionHostId: 'local',
      isPinned
    } as Tab
    await useIpcEventsForCloseRouting({
      closeActiveTabListenerRef,
      getState: () => ({
        activeWorktreeId: 'workspace',
        activeTabType: 'canvas',
        getActiveTab: () => tab,
        unifiedTabsByWorktree: { workspace: [tab] },
        closeUnifiedTab,
        closeTab
      })
    })
    closeActiveTabListenerRef.current?.()
    await vi.waitFor(() => expect(clearContext).toHaveBeenCalledTimes(isPinned ? 0 : 1))
    if (!isPinned) {
      await vi.waitFor(() => expect(closeUnifiedTab).toHaveBeenCalledTimes(1))
      expect(clearContext).toHaveBeenCalledWith(tab)
    }
    expect(closeUnifiedTab).toHaveBeenCalledTimes(isPinned ? 0 : 1)
    if (!isPinned) {
      expect(closeUnifiedTab).toHaveBeenCalledWith('canvas')
    }
    expect(closeTab).not.toHaveBeenCalled()
  }
)

it('keeps the canvas open while shortcut cleanup is pending or fails', async () => {
  const listener: { current: CloseActiveTabListener | null } = { current: null }
  const closeUnifiedTab = vi.fn()
  let reject!: (error: Error) => void
  clearContext.mockImplementation(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail
      })
  )
  const tab = {
    id: 'canvas',
    contentType: 'canvas',
    worktreeId: 'workspace',
    executionHostId: 'local'
  } as Tab
  await useIpcEventsForCloseRouting({
    closeActiveTabListenerRef: listener,
    getState: () => ({
      activeWorktreeId: 'workspace',
      activeTabType: 'canvas',
      getActiveTab: () => tab,
      unifiedTabsByWorktree: { workspace: [tab] },
      closeUnifiedTab
    })
  })
  listener.current?.()
  listener.current?.()
  expect(clearContext).toHaveBeenCalledTimes(1)
  expect(closeUnifiedTab).not.toHaveBeenCalled()
  reject(new Error('Execution host unavailable'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(closeUnifiedTab).not.toHaveBeenCalled()
})
