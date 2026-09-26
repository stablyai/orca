import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './browser-slice-test-harness'
import {
  admitBrowserPageMount,
  isBrowserPageMountAdmitted,
  releaseBrowserPageMount
} from '@/components/browser-pane/host-guest/browser-page-mount-admission'

vi.mock('@/lib/doc-preview-grants', () => ({ releaseDocPreviewGrant: vi.fn() }))

const docLocation = {
  kind: 'workspace-doc' as const,
  worktreeId: 'wt-1',
  filePath: '/report.html'
}
const pageIds = new Set<string>()

function createWebPage(options?: { activate?: boolean; browserRuntimeEnvironmentId?: string }) {
  const store = createTestStore()
  const workspace = store.getState().createBrowserTab('wt-1', 'https://example.com/', options)
  const page = store.getState().browserPagesByWorkspace[workspace.id]?.[0]
  if (!page) {
    throw new Error('Created browser page missing')
  }
  pageIds.add(page.id)
  return { store, workspace, page }
}

afterEach(() => {
  for (const pageId of pageIds) {
    releaseBrowserPageMount(pageId)
  }
  pageIds.clear()
  vi.unstubAllGlobals()
})

describe('browser page conversion mount admission', () => {
  it.each([true, false])('releases a replaced web page when activate is %s', (activate) => {
    const { store, workspace, page } = createWebPage({ activate })
    expect(isBrowserPageMountAdmitted(page.id)).toBe(true)

    const converted = store.getState().convertBrowserPage(page.id, {
      kind: 'workspace-doc',
      docLocation
    })

    expect(converted?.id).not.toBe(page.id)
    expect(store.getState().browserPagesByWorkspace[workspace.id]?.[0]?.id).toBe(converted?.id)
    expect(isBrowserPageMountAdmitted(page.id)).toBe(false)
  })

  it('releases a converted child page without retiring its sibling', () => {
    const { store, workspace, page } = createWebPage()
    const child = store.getState().createBrowserPage(workspace.id, 'https://example.com/child')
    if (!child) {
      throw new Error('Created child missing')
    }
    pageIds.add(child.id)

    store.getState().convertBrowserPage(child.id, { kind: 'workspace-doc', docLocation })

    expect(isBrowserPageMountAdmitted(child.id)).toBe(false)
    expect(isBrowserPageMountAdmitted(page.id)).toBe(true)
  })

  it('keeps the live admission when web-to-web conversion is rejected', () => {
    const { store, page } = createWebPage()

    expect(
      store.getState().convertBrowserPage(page.id, {
        kind: 'web',
        url: 'https://example.com/other'
      })
    ).toBeNull()

    expect(isBrowserPageMountAdmitted(page.id)).toBe(true)
  })

  it('keeps admission when no page can be converted', () => {
    const { store, page } = createWebPage()
    const unknownId = 'unmatched-page-admission'
    admitBrowserPageMount(unknownId)
    pageIds.add(unknownId)

    expect(
      store.getState().convertBrowserPage(unknownId, {
        kind: 'workspace-doc',
        docLocation
      })
    ).toBeNull()

    expect(isBrowserPageMountAdmitted(unknownId)).toBe(true)
    expect(isBrowserPageMountAdmitted(page.id)).toBe(true)
  })

  it('retires admission only after the state stops naming the old page', () => {
    const { store, workspace, page } = createWebPage()
    const admissionsDuringPublication: boolean[] = []
    const unsubscribe = store.subscribe((state) => {
      expect(state.browserPagesByWorkspace[workspace.id]?.some((row) => row.id === page.id)).toBe(
        false
      )
      admissionsDuringPublication.push(isBrowserPageMountAdmitted(page.id))
    })
    try {
      store.getState().convertBrowserPage(page.id, { kind: 'workspace-doc', docLocation })
    } finally {
      unsubscribe()
    }

    expect(admissionsDuringPublication).toEqual([true])
    expect(isBrowserPageMountAdmitted(page.id)).toBe(false)
  })

  it('keeps admission when the client refuses the conversion', () => {
    const { store, page } = createWebPage()
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)

    expect(() =>
      store.getState().convertBrowserPage(page.id, {
        kind: 'workspace-doc',
        docLocation
      })
    ).toThrow('Managed browser tabs in the web client must be created by a capable paired runtime.')

    expect(isBrowserPageMountAdmitted(page.id)).toBe(true)
  })

  it('preserves a new page that reuses the retired ID during state publication', () => {
    const { store, workspace, page } = createWebPage()
    let restoredWorkspaceId: string | null = null
    let restoring = false
    const unsubscribe = store.subscribe((state) => {
      if (
        restoring ||
        state.browserPagesByWorkspace[workspace.id]?.some((row) => row.id === page.id)
      ) {
        return
      }
      restoring = true
      restoredWorkspaceId = store
        .getState()
        .createBrowserTab('wt-1', 'https://example.com/restored', {
          browserPageId: page.id,
          activate: false
        }).id
    })
    try {
      store.getState().convertBrowserPage(page.id, { kind: 'workspace-doc', docLocation })
    } finally {
      unsubscribe()
    }

    expect(restoredWorkspaceId).not.toBeNull()
    expect(isBrowserPageMountAdmitted(page.id)).toBe(true)
    if (restoredWorkspaceId) {
      store.getState().closeBrowserTab(restoredWorkspaceId)
    }
    expect(isBrowserPageMountAdmitted(page.id)).toBe(false)
  })

  it('does not admit a streamed remote page while converting it to a document', () => {
    const { store, page } = createWebPage({ browserRuntimeEnvironmentId: 'remote-1' })
    expect(isBrowserPageMountAdmitted(page.id)).toBe(false)

    const converted = store.getState().convertBrowserPage(page.id, {
      kind: 'workspace-doc',
      docLocation
    })

    expect(converted?.browserRuntimeEnvironmentId).toBeNull()
    expect(isBrowserPageMountAdmitted(page.id)).toBe(false)
    if (!converted) {
      throw new Error('Converted page missing')
    }
    expect(isBrowserPageMountAdmitted(converted.id)).toBe(false)
  })

  it('does not retain retired admissions after repeated convert and close cycles', () => {
    const store = createTestStore()
    const retiredIds: string[] = []
    for (let index = 0; index < 50; index += 1) {
      const workspace = store.getState().createBrowserTab('wt-1', 'https://example.com/')
      const page = store.getState().browserPagesByWorkspace[workspace.id]?.[0]
      if (!page) {
        throw new Error('Created browser page missing')
      }
      retiredIds.push(page.id)
      pageIds.add(page.id)
      store.getState().convertBrowserPage(page.id, { kind: 'workspace-doc', docLocation })
      store.getState().closeBrowserTab(workspace.id)
    }

    expect(Object.keys(store.getState().browserPagesByWorkspace)).toHaveLength(0)
    expect(retiredIds.filter(isBrowserPageMountAdmitted)).toEqual([])
  })
})
