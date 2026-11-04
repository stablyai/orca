// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

type CloseRequestHandler = (request: { isQuitting: boolean }) => void
const coordinator = vi.hoisted(() => {
  const state: { request: CloseRequestHandler | null } = { request: null }
  return state
})
vi.mock('./window-close-request-coordinator', () => ({
  setWindowCloseRequestHandler: (handler: CloseRequestHandler | null) => {
    coordinator.request = handler
  }
}))

import { useAppStore } from '../store'
import { makeOpenFile } from '../store/slices/store-session-test-harness'
import { registerEditorFrameFlush } from './editor/editor-pending-flush'
import { useTerminalWindowLifecycle } from './use-terminal-window-lifecycle'

const drainMicrotasks = () => new Promise((resolve) => setImmediate(resolve))
let removeFrame = () => {}
afterEach(() => {
  removeFrame()
  cleanup()
})

function mountLifecycle() {
  const windowCloseAfterDirtyRef: { current: { isQuitting: boolean } | null } = { current: null }
  const queueEditorCloseRequests = vi.fn(
    (_fileIds: string[], pending?: { isQuitting: boolean }) => {
      windowCloseAfterDirtyRef.current = pending ?? null
    }
  )
  const proceedToNativeWindowClose = vi.fn()
  renderHook(() =>
    useTerminalWindowLifecycle({
      activeBrowserTabId: null,
      activeTabType: 'terminal',
      activeWorktreeBrowserTabIdsKey: '',
      proceedToNativeWindowClose,
      queueEditorCloseRequests,
      renderedActiveWorktreeId: null,
      setActiveBrowserTab: vi.fn(),
      setActiveTabType: vi.fn(),
      windowCloseAfterDirtyRef
    })
  )
  return { windowCloseAfterDirtyRef, queueEditorCloseRequests, proceedToNativeWindowClose }
}

// Why: a repeated quit during the flush must not reopen a save prompt the user cancelled.
it('claims the close before flushing frames and drops it once the user cancels', async () => {
  let answer: (flushed: boolean) => void = () => {}
  removeFrame = registerEditorFrameFlush('doc', () => new Promise((resolve) => (answer = resolve)))
  useAppStore.setState({
    openFiles: [makeOpenFile({ id: 'doc', worktreeId: 'wt', isDirty: true })]
  })
  const lifecycle = mountLifecycle()

  coordinator.request?.({ isQuitting: true })
  coordinator.request?.({ isQuitting: true })
  answer(true)
  await drainMicrotasks()
  expect(lifecycle.queueEditorCloseRequests).toHaveBeenCalledTimes(1)

  lifecycle.windowCloseAfterDirtyRef.current = null
  coordinator.request?.({ isQuitting: true })
  lifecycle.windowCloseAfterDirtyRef.current = null
  answer(true)
  await drainMicrotasks()
  expect(lifecycle.queueEditorCloseRequests).toHaveBeenCalledTimes(1)
  expect(lifecycle.proceedToNativeWindowClose).not.toHaveBeenCalled()
})
