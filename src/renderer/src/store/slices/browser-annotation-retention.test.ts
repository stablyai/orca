import { afterEach, describe, expect, it, vi } from 'vitest'
import { GRAB_BUDGET } from '../../../../shared/browser-grab-types'
import { createBrowserMockApi, createTestStore } from './browser-slice-test-harness'
import { makeAnnotation } from './browser-annotation-test-fixture'

vi.mock('@/runtime/web-runtime-session', () => ({ createWebRuntimeSessionBrowserTab: vi.fn() }))

function createAnnotatedPage() {
  vi.stubGlobal('window', { api: createBrowserMockApi(vi.fn()) })
  const store = createTestStore()
  store.setState({ repos: [], folderWorkspaces: [] })
  const workspace = store.getState().createBrowserTab('wt-1', 'https://example.com')
  const pageId = workspace.activePageId
  if (!pageId) {
    throw new Error('Expected browser page')
  }
  store.getState().addBrowserPageAnnotation(makeAnnotation(pageId))
  return { store, workspace, pageId }
}

afterEach(() => vi.unstubAllGlobals())

describe('saved browser note lifetime and marker eligibility', () => {
  it('retires same-URL geometry without changing the saved array or object references', () => {
    const { store, pageId } = createAnnotatedPage()
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

  it('shares the 20-note budget across URLs and bounds marker IDs to retained notes', () => {
    const { store, pageId } = createAnnotatedPage()
    for (let index = 0; index < GRAB_BUDGET.annotationsMaxPerPage + 3; index++) {
      const url = `https://example.com/page-${index % 2}`
      store.getState().setBrowserPageUrl(pageId, url)
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

  it('prunes eligible IDs when the oldest current-document notes are evicted', () => {
    const { store, pageId } = createAnnotatedPage()
    for (let index = 0; index < 22; index++) {
      store.getState().addBrowserPageAnnotation(makeAnnotation(pageId, `note-${index}`))
    }
    expect(store.getState().browserAnnotationMarkerIdsByPageId[pageId]).toEqual(
      store.getState().browserAnnotationsByPageId[pageId].map((note) => note.id)
    )
    expect(store.getState().browserAnnotationMarkerIdsByPageId[pageId]).toHaveLength(20)
  })

  it('removes an accepted delivery snapshot after navigation while preserving later edits and additions', async () => {
    const { store, pageId } = createAnnotatedPage()
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

  it.each(['page', 'workspace', 'conversion', 'hydration'] as const)(
    'cleans up note and marker authority on %s teardown',
    (mode) => {
      const { store, workspace, pageId } = createAnnotatedPage()
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
      expect(store.getState().browserAnnotationsByPageId[pageId]).toBeUndefined()
      expect(store.getState().browserAnnotationMarkerIdsByPageId[pageId]).toBeUndefined()
    }
  )
})
