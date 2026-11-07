import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../types'
import {
  registerPersistentWebview,
  unregisterPersistentWebview
} from '../../../../components/browser-pane/host-guest/webview-registry'
import '../../../../../../shared/workspace-scope'

import { createWebview } from '../../browser/browser-webview.test-fixture'
import { makeWorktree } from '../worktree.test-fixture'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from '../worktrees-slice-test-harness'

const requestWorktreeBaseFallbackNotice = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice
}))

beforeEach(resetWorktreeSliceModuleMemory)

describe('setActiveWorktree focus handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.ephemeralVm.cancelProvision.mockResolvedValue({ cancelled: true })
    mockApi.ephemeralVm.cleanup.mockResolvedValue({})
  })

  it('moves focus out of a registered webview before switching worktrees', () => {
    const store = createTestStore()
    const current = makeWorktree({ id: 'repo1::/path/current', repoId: 'repo1' })
    const next = makeWorktree({ id: 'repo1::/path/next', repoId: 'repo1' })
    const webview = createWebview()
    const focusRenderer = vi.fn(() => {
      expect(store.getState().activeWorktreeId).toBe(current.id)
    })
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const testWindow = globalThis.window as unknown as { focus?: () => void }
    const previousFocus = testWindow.focus

    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { activeElement: webview }
    })
    testWindow.focus = focusRenderer
    registerPersistentWebview('page-1', webview)

    try {
      store.setState({
        worktreesByRepo: { repo1: [current, next] },
        activeWorktreeId: current.id,
        reconcileWorktreeTabModel: vi.fn(() => ({
          activeRenderableTabId: null,
          renderableTabCount: 0
        })),
        refreshGitHubForWorktreeIfStale: vi.fn()
      } as unknown as Partial<AppState>)

      store.getState().setActiveWorktree(next.id)

      expect(webview.blur).toHaveBeenCalledTimes(1)
      expect(focusRenderer).toHaveBeenCalledTimes(1)
      expect(store.getState().activeWorktreeId).toBe(next.id)
    } finally {
      unregisterPersistentWebview('page-1')
      if (previousDocument) {
        Object.defineProperty(globalThis, 'document', previousDocument)
      } else {
        delete (globalThis as unknown as { document?: unknown }).document
      }
      if (previousFocus) {
        testWindow.focus = previousFocus
      } else {
        delete testWindow.focus
      }
    }
  })
})
