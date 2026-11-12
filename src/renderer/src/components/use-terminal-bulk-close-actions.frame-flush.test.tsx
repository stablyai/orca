// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('./use-bulk-tab-close-confirmation', () => ({ useBulkTabCloseConfirmation: () => vi.fn() }))

import { useAppStore } from '../store'
import { makeOpenFile } from '../store/slices/editor/types/open-file.test-fixture'
import { makeTab } from '../store/terminals/terminal-tab.test-fixture'
import { makeUnifiedTab } from '../store/slices/tabs/tab-group.test-fixture'
import { registerEditorFrameFlush } from './editor/save/flush/editor-pending-flush'
import { useTerminalBulkCloseActions } from './use-terminal-bulk-close-actions'

const worktreeId = 'wt'
const drainMicrotasks = () => new Promise((resolve) => setImmediate(resolve))
let removeFrame = () => {}
afterEach(() => {
  removeFrame()
  cleanup()
})

// Why: only tabs with a mounted frame wait on its flush deadline.
it('closes a terminal at once while a framed editor waits for its flush', async () => {
  let answer: (flushed: boolean) => void = () => {}
  removeFrame = registerEditorFrameFlush('doc', () => new Promise((resolve) => (answer = resolve)))
  useAppStore.setState({
    tabsByWorktree: { [worktreeId]: [makeTab({ id: 'term', worktreeId })] },
    openFiles: [makeOpenFile({ id: 'doc', worktreeId })],
    unifiedTabsByWorktree: {
      [worktreeId]: [
        makeUnifiedTab({ id: 'term', worktreeId, groupId: 'g' }),
        makeUnifiedTab({ id: 'doc', worktreeId, groupId: 'g', contentType: 'editor' })
      ]
    }
  })
  const closeTab = vi.fn()
  const closeFile = vi.fn()
  const closeUnifiedTabs = vi
    .spyOn(useAppStore.getState(), 'closeUnifiedTabs')
    .mockImplementation(() => {})
  const { result } = renderHook(() =>
    useTerminalBulkCloseActions({
      activeWorktreeId: worktreeId,
      closeBrowserTab: vi.fn(),
      closeFile,
      closeTab,
      queueEditorCloseRequests: vi.fn()
    })
  )

  result.current.closeTabBarTabs(['term', 'doc'])
  expect(closeTab).toHaveBeenCalledWith('term')
  expect(closeFile).not.toHaveBeenCalled()

  answer(true)
  await drainMicrotasks()
  expect(closeUnifiedTabs).toHaveBeenLastCalledWith(['doc'])
  closeUnifiedTabs.mockRestore()
  expect(closeTab).toHaveBeenCalledTimes(1)
})
