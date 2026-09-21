// @vitest-environment happy-dom

/**
 * `collectBrowserWebviewIds` walks every browser page and tab across every worktree. It used to sit
 * in a `useRef(...)` argument, so `Terminal` paid for the whole walk on every render and threw the
 * result away. Pin the invocation count to the mount count, not the render count.
 */
import { useState } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const collectBrowserWebviewIdsCalls = vi.hoisted(() => ({ count: 0 }))

vi.mock('../store', () => {
  const state = {
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    openFiles: []
  }
  const useAppStore = Object.assign(() => undefined, {
    getState: () => state,
    subscribe: () => () => {}
  })
  return { useAppStore }
})

vi.mock('../store/slices/browser-webview-cleanup', () => ({
  collectBrowserWebviewIds: (...args: unknown[]) => {
    collectBrowserWebviewIdsCalls.count += 1
    void args
    return new Set<string>()
  },
  destroyRemovedBrowserWebview: vi.fn()
}))

vi.mock('@/lib/updater-beforeunload', () => ({
  isIntentionalAppRestartInProgress: () => false
}))
vi.mock('@/lib/shutdown-checkpoint-guard', () => ({
  preventUnloadAndScheduleShutdownCheckpointReset: vi.fn()
}))
vi.mock('./window-close-request-coordinator', () => ({
  setWindowCloseRequestHandler: vi.fn()
}))

const { useTerminalWindowLifecycle } = await import('./use-terminal-window-lifecycle')

const controller = {
  activeBrowserTabId: null,
  activeTabType: 'terminal',
  activeWorktreeBrowserTabIdsKey: '',
  proceedToNativeWindowClose: () => {},
  queueEditorCloseRequests: () => {},
  renderedActiveWorktreeId: null,
  setActiveBrowserTab: () => {},
  setActiveTabType: () => {},
  windowCloseAfterDirtyRef: { current: false }
} as unknown as Parameters<typeof useTerminalWindowLifecycle>[0]

let bumpRender: (() => void) | null = null

function Host(): null {
  const [, setTick] = useState(0)
  bumpRender = () => setTick((tick) => tick + 1)
  useTerminalWindowLifecycle(controller)
  return null
}

afterEach(() => {
  cleanup()
  collectBrowserWebviewIdsCalls.count = 0
  bumpRender = null
})

describe('useTerminalWindowLifecycle browser-webview id seed', () => {
  it('collects the id set once per mount, not once per render', () => {
    render(<Host />)
    expect(collectBrowserWebviewIdsCalls.count).toBe(1)

    for (let i = 0; i < 20; i += 1) {
      act(() => bumpRender?.())
    }

    expect(collectBrowserWebviewIdsCalls.count).toBe(1)
  })
})
