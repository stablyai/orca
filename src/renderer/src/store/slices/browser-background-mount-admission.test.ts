import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isBrowserPageMountAdmitted,
  releaseBrowserPageMount
} from '../../components/browser-pane/host-guest/browser-page-mount-admission'
import { createBrowserMockApi, createTestStore } from './browser-slice-test-harness'

vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionBrowserTab: vi.fn()
}))

const pagesToRelease: string[] = []

// @ts-expect-error test window mock
globalThis.window = { api: createBrowserMockApi(vi.fn()) }

afterEach(() => {
  pagesToRelease.splice(0).forEach(releaseBrowserPageMount)
})

describe('new background URL page admission', () => {
  it.each([undefined, 'env-1'])(
    'admits a new workspace page on runtime %s without activation',
    (environmentId) => {
      const store = createTestStore()
      const workspace = store.getState().createBrowserTab('wt-1', 'https://example.test/link', {
        activate: false,
        browserRuntimeEnvironmentId: environmentId
      })
      const page = store.getState().browserPagesByWorkspace[workspace.id][0]
      pagesToRelease.push(page.id)

      expect(isBrowserPageMountAdmitted(page.id)).toBe(true)
      expect(store.getState().activeTabType).toBe('terminal')
      expect(store.getState().createUnifiedTab).toHaveBeenCalledWith(
        'wt-1',
        'browser',
        expect.objectContaining({ activate: false })
      )
    }
  )

  it.each([undefined, 'env-1'])(
    'admits a second background page on runtime %s without selecting it',
    (environmentId) => {
      const store = createTestStore()
      const workspace = store.getState().createBrowserTab('wt-1', 'https://example.test/first')
      const firstPageId = workspace.activePageId!
      pagesToRelease.push(firstPageId)
      const page = store.getState().createBrowserPage(workspace.id, 'https://example.test/link', {
        activate: false,
        browserRuntimeEnvironmentId: environmentId
      })!
      pagesToRelease.push(page.id)

      expect(isBrowserPageMountAdmitted(page.id)).toBe(true)
      expect(store.getState().browserTabsByWorktree['wt-1'][0].activePageId).toBe(firstPageId)
    }
  )
})
