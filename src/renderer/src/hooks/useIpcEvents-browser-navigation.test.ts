import { describe, expect, it, vi } from 'vitest'
import { resolveBrowserSessionTabTarget } from './ipc-events/browser-session-tab-target'
import { createHarnessStoreState, loadIpcEventsHarness } from './ipc-events-test-harness'

describe('browser navigation updates', () => {
  it('commits CDP navigation URLs to the render-time cache before updating the store', async () => {
    let liveUrlDuringStoreWrite: string | null = null
    let readLiveUrl = (_browserPageId: string): string | null => null
    const setBrowserPageUrl = vi.fn((browserPageId: string) => {
      liveUrlDuringStoreWrite = readLiveUrl(browserPageId)
    })
    const updateBrowserPageState = vi.fn()
    const storeState = createHarnessStoreState({
      tabsByWorktree: {},
      browserPagesByWorkspace: { 'workspace-1': [{ id: 'page-1' }] },
      setBrowserPageUrl,
      updateBrowserPageState
    })
    const harness = await loadIpcEventsHarness(storeState)
    const { clearLiveBrowserUrl, getLiveBrowserUrl } =
      await import('@/components/browser-pane/describe-page/live-browser-url-registry')
    readLiveUrl = getLiveBrowserUrl
    harness.useIpcEvents()

    harness.navigationUpdate({
      browserPageId: 'page-1',
      url: 'https://kagi.com/search?token=secret&q=next',
      title: 'Next'
    })

    expect(liveUrlDuringStoreWrite).toBe('https://kagi.com/search?q=next')
    expect(getLiveBrowserUrl('page-1')).toBe('https://kagi.com/search?q=next')
    expect(setBrowserPageUrl).toHaveBeenCalledWith(
      'page-1',
      'https://kagi.com/search?token=secret&q=next'
    )
    expect(updateBrowserPageState).toHaveBeenCalledWith('page-1', {
      title: 'Next',
      loading: false
    })
    clearLiveBrowserUrl('page-1')
  })

  it('does not restore closed-page URLs when delayed navigation updates arrive', async () => {
    const storeState = createHarnessStoreState({
      tabsByWorktree: {},
      browserPagesByWorkspace: {},
      setBrowserPageUrl: vi.fn(),
      updateBrowserPageState: vi.fn()
    })
    const harness = await loadIpcEventsHarness(storeState)
    const { clearLiveBrowserUrl, getLiveBrowserUrl } =
      await import('@/components/browser-pane/describe-page/live-browser-url-registry')
    harness.useIpcEvents()
    const pageIds = Array.from({ length: 32 }, (_, index) => `closed-page-${index}`)

    try {
      for (const pageId of pageIds) {
        storeState.browserPagesByWorkspace = { workspace: [{ id: pageId }] }
        harness.navigationUpdate({ browserPageId: pageId, url: 'https://example.com/', title: '' })
        expect(getLiveBrowserUrl(pageId)).toBe('https://example.com/')

        storeState.browserPagesByWorkspace = {}
        clearLiveBrowserUrl(pageId)
        harness.navigationUpdate({
          browserPageId: pageId,
          url: `https://example.com/late/${pageId}`,
          title: ''
        })
      }

      expect(pageIds.filter((pageId) => getLiveBrowserUrl(pageId) !== null)).toEqual([])
    } finally {
      pageIds.forEach(clearLiveBrowserUrl)
    }
  })
})

describe('resolveBrowserSessionTabTarget', () => {
  it('resolves unified browser tabs to their browser workspace', () => {
    expect(
      resolveBrowserSessionTabTarget(
        {
          unifiedTabsByWorktree: {
            'wt-1': [
              {
                id: 'unified-browser',
                groupId: 'group-1',
                contentType: 'browser',
                entityId: 'browser-workspace'
              }
            ]
          },
          browserTabsByWorktree: {
            'wt-1': [{ id: 'browser-workspace' }]
          }
        } as never,
        'wt-1',
        'unified-browser'
      )
    ).toEqual({
      kind: 'unified-browser',
      unifiedTabId: 'unified-browser',
      workspaceId: 'browser-workspace',
      groupId: 'group-1'
    })
  })

  it('resolves fallback mobile browser tabs by workspace id', () => {
    expect(
      resolveBrowserSessionTabTarget(
        {
          unifiedTabsByWorktree: { 'wt-1': [] },
          browserTabsByWorktree: {
            'wt-1': [{ id: 'browser-workspace' }]
          }
        } as never,
        'wt-1',
        'browser-workspace'
      )
    ).toEqual({
      kind: 'fallback-browser',
      workspaceId: 'browser-workspace'
    })
  })
})
