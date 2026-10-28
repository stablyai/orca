import { afterEach, describe, expect, it, vi } from 'vitest'
import { GRAB_BUDGET } from '../../../../shared/browser-grab-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { createBrowserMockApi } from './browser-slice-test-harness'
import { createTestStoreDrawnFromMain } from './browser-slice-drawn-from-main.test-fixture'
import { makeAnnotation } from './browser-annotation-test-fixture'

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
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
  it('retires same-URL geometry without changing the saved array or object references', async () => {
    const { store, pageId } = await createAnnotatedPage()
    const saved = store.getState().browserAnnotationsByPageId[pageId]
    const note = saved[0]
    expect(store.getState().browserAnnotationMarkerIdsByPageId[pageId]).toEqual([note.id])

    store.getState().setBrowserPageUrl(pageId, 'https://example.com')
    expect(store.getState().browserAnnotationMarkerIdsByPageId[pageId]).toEqual([note.id])
    store.getState().invalidateBrowserPageAnnotationGeometry(pageId)

    expect(store.getState().browserAnnotationsByPageId[pageId]).toBe(saved)
    expect(store.getState().browserAnnotationsByPageId[pageId][0]).toBe(note)
    expect(store.getState().browserAnnotationMarkerIdsByPageId[pageId]).toBeUndefined()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    store.getState().invalidateBrowserPageAnnotationGeometry(pageId)
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()

    store.getState().addBrowserPageAnnotation(makeAnnotation(pageId, 'fresh'))
    expect(store.getState().browserAnnotationsByPageId[pageId][0]).toBe(note)
    expect(store.getState().browserAnnotationMarkerIdsByPageId[pageId]).toEqual(['fresh'])
  })

  it('shares the 20-note budget across URLs and bounds marker IDs to retained notes', async () => {
    const { store, pageId } = await createAnnotatedPage()
    for (let index = 0; index < GRAB_BUDGET.annotationsMaxPerPage + 3; index++) {
      const url = `https://example.com/page-${index % 2}`
      store.getState().setBrowserPageUrl(pageId, url)
      store.getState().invalidateBrowserPageAnnotationGeometry(pageId)
      const note = makeAnnotation(pageId, `note-${index}`)
      note.payload.page.sanitizedUrl = url
      store.getState().addBrowserPageAnnotation(note)
    }
    const saved = store.getState().browserAnnotationsByPageId[pageId]
    const eligible = store.getState().browserAnnotationMarkerIdsByPageId[pageId]
    expect(saved).toHaveLength(20)
    expect(saved[0].id).toBe('note-3')
    expect(new Set(saved.map((note) => note.payload.page.sanitizedUrl)).size).toBe(2)
    expect(eligible).toEqual(['note-22'])
    expect(eligible.every((id) => saved.some((note) => note.id === id))).toBe(true)

    store.getState().deleteBrowserPageAnnotation(pageId, 'note-22')
    expect(store.getState().browserAnnotationMarkerIdsByPageId[pageId]).toBeUndefined()
    store.getState().clearBrowserPageAnnotations(pageId)
    expect(store.getState().browserAnnotationsByPageId[pageId]).toBeUndefined()
  })

  it('prunes eligible IDs when the oldest current-document notes are evicted', async () => {
    const { store, pageId } = await createAnnotatedPage()
    for (let index = 0; index < 22; index++) {
      store.getState().addBrowserPageAnnotation(makeAnnotation(pageId, `note-${index}`))
    }
    expect(store.getState().browserAnnotationMarkerIdsByPageId[pageId]).toEqual(
      store.getState().browserAnnotationsByPageId[pageId].map((note) => note.id)
    )
    expect(store.getState().browserAnnotationMarkerIdsByPageId[pageId]).toHaveLength(20)
  })

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
