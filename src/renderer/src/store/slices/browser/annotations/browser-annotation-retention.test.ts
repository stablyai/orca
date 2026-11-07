import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { createBrowserMockApi } from '../browser-slice-test-harness'
import { createTestStoreDrawnFromMain } from '../browser-slice-drawn-from-main.test-fixture'
import { makeAnnotation } from './browser-annotation-test-fixture'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)
vi.mock('@/runtime/web-runtime-browser-creation', () => ({
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

  it.each([
    ['page', 'closeBrowserPage'],
    ['workspace', 'closeTabs'],
    ['conversion', 'replaceBrowserPage'],
    ['hydration', null]
  ] as const)('cleans up note and marker authority on %s teardown', async (mode, mainCommand) => {
    const { store, main, workspace, pageId } = await createAnnotatedPage()
    if (mode === 'page') {
      store.getState().closeBrowserPage(pageId)
    }
    if (mode === 'workspace') {
      store.getState().closeBrowserTab(workspace.id)
    }
    if (mode === 'conversion') {
      store.getState().convertBrowserPage(pageId, {
        kind: 'workspace-doc',
        docLocation: {
          kind: 'workspace-doc',
          worktreeId: 'wt-1',
          filePath: '/workspace/index.html'
        }
      })
    }
    if (mode === 'hydration') {
      store.getState().hydrateBrowserSession({
        activeRepoId: null,
        activeWorktreeId: null,
        activeTabId: null,
        tabsByWorktree: {},
        terminalLayoutsByTabId: {}
      })
    }
    await main.settle()
    // A layout-owner build's teardown is main's, drawn from its frame.
    expect(layoutApplyTestTransport.sent.map((command) => command.type)).toEqual(
      ORCA_LAYOUT_OWNER_IS_MAIN ? ['openBrowserTab', ...(mainCommand ? [mainCommand] : [])] : []
    )
    expect(store.getState().browserAnnotationsByPageId[pageId]).toBeUndefined()
    expect(store.getState().browserAnnotationMarkerIdsByPageId[pageId]).toBeUndefined()
  })
})
