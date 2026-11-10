import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserMockApi } from '../browser-slice-test-harness'
import { createTestStoreDrawnFromMain } from '../browser-slice-drawn-from-main.test-fixture'
import { makeAnnotation } from './browser-annotation-test-fixture'

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
  createWebRuntimeSessionBrowserTab: vi.fn()
}))

async function createAnnotatedPage() {
  vi.stubGlobal('window', { api: createBrowserMockApi(vi.fn()) })
  const { store, main } = await createTestStoreDrawnFromMain({ repos: [], folderWorkspaces: [] })
  const workspace = store.getState().createBrowserTab('wt-1', 'https://example.com')
  await main.settle()
  const pageId = workspace.activePageId
  if (!pageId) {
    throw new Error('Expected browser page')
  }
  store.getState().addBrowserPageAnnotation(makeAnnotation(pageId))
  return { store, main, workspace, pageId }
}

afterEach(() => vi.unstubAllGlobals())

describe('saved browser note lifetime and marker eligibility', () => {
  it('removes an accepted delivery snapshot after navigation while preserving later edits and additions', async () => {
    const { store, pageId } = await createAnnotatedPage()
    store.getState().addBrowserPageAnnotation(makeAnnotation(pageId, 'edited'))
    const delivered = store.getState().browserAnnotationsByPageId[pageId]
    let accept!: () => void
    const delivery = new Promise<void>((resolve) => {
      accept = resolve
    }).then(() => {
      store.getState().removeDeliveredBrowserPageAnnotations(pageId, delivered)
    })
    store.getState().setBrowserPageUrl(pageId, 'https://example.com/next')
    store.getState().invalidateBrowserPageAnnotationGeometry(pageId)
    store.getState().updateBrowserPageAnnotation(pageId, 'edited', {
      comment: 'Edited while sending',
      intent: 'fix'
    })
    store.getState().addBrowserPageAnnotation(makeAnnotation(pageId, 'fresh'))
    accept()
    await delivery

    const remaining = store.getState().browserAnnotationsByPageId[pageId]
    expect(remaining.map((note) => note.id)).toEqual(['edited', 'fresh'])
    expect(remaining[0].comment).toBe('Edited while sending')
    expect(store.getState().browserAnnotationMarkerIdsByPageId[pageId]).toEqual(['fresh'])
    store.getState().removeDeliveredBrowserPageAnnotations(pageId, remaining)
    expect(store.getState().browserAnnotationsByPageId[pageId]).toBeUndefined()
    expect(store.getState().browserAnnotationMarkerIdsByPageId[pageId]).toBeUndefined()
  })
})
