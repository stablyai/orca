// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { RemoteBrowserPageHandle } from '@/store/slices/browser/browser-slice-contract'
import { buildRestoredRemoteBrowserPageHandles } from '@/store/slices/browser/hosts/browser-host-state'
import { markHydratedBrowserPageHandles } from '@/store/slices/browser/hosts/browser-initialization-presentation-ownership'
import type { BrowserPage } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import { useClientHostViewer } from './use-client-host-viewer'

// Main's answer: null until the client host has started and recorded its viewer.
let mainViewer: 'teammate' | 'own-computer' | null = null
const read = vi.fn(async () => mainViewer)
Object.defineProperty(window, 'api', {
  value: { runtimeEnvironments: { browserClientHostViewer: read } },
  configurable: true
})

const livePlacement = {
  kind: 'client' as const,
  browserHostClientId: 'this-desktop',
  browserHostGeneration: 1,
  pageHostGeneration: 1
}

function setHandle(handle: RemoteBrowserPageHandle): void {
  useAppStore.setState({
    remoteBrowserPageHandlesByPageId: markHydratedBrowserPageHandles({ p1: handle })
  })
}

afterEach(() => {
  cleanup()
  read.mockClear()
  mainViewer = null
})

describe('useClientHostViewer', () => {
  it('stays unknown on a staged tab, then answers once its placement is live', async () => {
    setHandle({ environmentId: 'env', remotePageId: 'p1', staged: true, stagedClientHosted: true })
    const { result } = renderHook(() => useClientHostViewer('env', 'p1'))
    expect(result.current).toBe('unknown')
    expect(read).not.toHaveBeenCalled()

    mainViewer = 'teammate'
    act(() => setHandle({ environmentId: 'env', remotePageId: 'p1', placement: livePlacement }))
    await waitFor(() => expect(result.current).toBe('teammate'))
  })

  it('never latches a pre-start null on a restored tab', async () => {
    const page: BrowserPage = {
      id: 'p1',
      workspaceId: 'w1',
      worktreeId: 'wt',
      url: 'https://example.com/',
      title: '',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: 0,
      browserRuntimeEnvironmentId: 'env',
      remoteBrowserPageId: 'p1',
      remoteBrowserPageClientHosted: true
    }
    useAppStore.setState({
      remoteBrowserPageHandlesByPageId: markHydratedBrowserPageHandles(
        buildRestoredRemoteBrowserPageHandles({ w1: [page] })
      )
    })
    const { result } = renderHook(() => useClientHostViewer('env', 'p1'))
    expect(result.current).toBe('unknown')

    // The placement lands just before main records the viewer.
    act(() => setHandle({ environmentId: 'env', remotePageId: 'p1', placement: livePlacement }))
    await waitFor(() => expect(read).toHaveBeenCalled())
    expect(result.current).toBe('unknown')
    mainViewer = 'own-computer'
    await waitFor(() => expect(result.current).toBe('own-computer'))
  })
})
