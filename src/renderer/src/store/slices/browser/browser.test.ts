import { describe, expect, it, vi } from 'vitest'

import {
  GRAB_BUDGET,
  type BrowserPageAnnotation
} from '../../../../../shared/browser/element-grab/browser-grab-types'
import { makeAnnotation } from './annotations/browser-annotation-test-fixture'
import '../../../../../shared/orca-profiles/constants'
import '../../../../../shared/workspace-layout/layout-owner-switch'

import '@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture'
import { createBrowserMockApi } from './browser-slice-test-harness'
import { createTestStoreDrawnFromMain } from './browser-slice-drawn-from-main.test-fixture'

const createWebRuntimeSessionBrowserTabMock = vi.hoisted(() => vi.fn())
const runtimeEnvironmentTransportCall = vi.fn()

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)
vi.mock('@/runtime/browser/creation/web-runtime-browser-creation', () => ({
  createWebRuntimeSessionBrowserTab: createWebRuntimeSessionBrowserTabMock
}))

const mockApi = createBrowserMockApi(runtimeEnvironmentTransportCall)

// @ts-expect-error test window mock
globalThis.window = { api: mockApi }

describe('createBrowserSlice annotations', () => {
  it('keeps a requested canonical page identity distinct from its workspace', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()
    const tab = store.getState().createBrowserTab('wt-1', 'about:blank', {
      browserPageId: 'page-canonical'
    })
    await main.settle()

    expect(tab.id).not.toBe('page-canonical')
    expect(tab.activePageId).toBe('page-canonical')
    expect(store.getState().browserPagesByWorkspace[tab.id]?.[0]?.id).toBe('page-canonical')
    expect(() =>
      store.getState().createBrowserTab('wt-1', 'about:blank', {
        browserPageId: 'page-canonical'
      })
    ).toThrow('Browser page page-canonical already exists')
  })

  it('keeps certificate challenges transient across navigation, success, and close', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()
    const tab = store.getState().createBrowserTab('wt-1', 'https://localhost:3443/')
    await main.settle()
    const pageId = tab.activePageId
    if (!pageId) {
      throw new Error('Expected a new browser page')
    }
    const failure = {
      challengeId: 'challenge-1',
      browserPageId: pageId,
      errorCode: -202,
      error: 'ERR_CERT_AUTHORITY_INVALID',
      origin: 'https://localhost:3443',
      displayHost: 'localhost:3443',
      canProceed: true,
      observedAt: 123
    }

    store.getState().setBrowserPageCertificateFailure(pageId, failure)
    expect(store.getState().browserCertificateFailuresByPageId[pageId]).toEqual(failure)

    store.getState().setBrowserPageUrl(pageId, 'https://localhost:3443/next')
    expect(store.getState().browserCertificateFailuresByPageId[pageId]).toBeUndefined()

    store.getState().setBrowserPageCertificateFailure(pageId, failure)
    store.getState().updateBrowserPageState(pageId, { loadError: null })
    expect(store.getState().browserCertificateFailuresByPageId[pageId]).toBeUndefined()

    store.getState().setBrowserPageCertificateFailure(pageId, failure)
    store.getState().closeBrowserTab(tab.id)
    await main.settle()
    expect(store.getState().browserCertificateFailuresByPageId[pageId]).toBeUndefined()
  })

  it('sanitizes persistent annotation payloads at the store boundary', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com')
    await main.settle()
    const pageId = tab.activePageId
    if (!pageId) {
      throw new Error('Expected a new browser page')
    }
    const annotation = makeAnnotation(pageId)
    const oversizedComment = 'a'.repeat(GRAB_BUDGET.annotationCommentMaxLength + 10)

    store.getState().addBrowserPageAnnotation({
      ...annotation,
      comment: oversizedComment,
      payload: {
        ...annotation.payload,
        screenshot: {
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,abc',
          width: 1,
          height: 1
        }
      } as unknown as BrowserPageAnnotation['payload']
    })

    const stored = store.getState().browserAnnotationsByPageId[pageId]?.[0]
    expect(stored?.payload.screenshot).toBeNull()
  })
})
