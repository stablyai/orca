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
