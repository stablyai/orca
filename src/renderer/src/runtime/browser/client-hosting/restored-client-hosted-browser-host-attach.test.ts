import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ensureBrowserClientHostOnRuntimeContact,
  ensureBrowserClientHostsForRestoredPages
} from './restored-client-hosted-browser-host-attach'
import { buildRestoredRemoteBrowserPageHandles } from '@/store/slices/browser/hosts/browser-host-state'

function stubPlacementProbe(): ReturnType<typeof vi.fn> {
  const prepare = vi.fn(async () => ({ kind: 'server' as const }))
  vi.stubGlobal('window', {
    api: { runtimeEnvironments: { prepareBrowserClientHostPlacement: prepare } }
  })
  return prepare
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('browser client host recovery', () => {
  it('skips Settings › Browser on contact only for pages this desktop placed, not on a server claim', async () => {
    const prepare = stubPlacementProbe()
    const handles = (placedHere: boolean) => ({
      remoteBrowserPageHandlesByPageId: {
        page: {
          environmentId: 'env-1',
          remotePageId: 'page',
          // A server can name this desktop's host id; that alone proves nothing.
          placement: {
            kind: 'client' as const,
            browserHostClientId: 'this-desktop',
            browserHostGeneration: 1,
            pageHostGeneration: 1
          },
          ...(placedHere ? { placedHere: true as const } : {})
        }
      }
    })
    await ensureBrowserClientHostOnRuntimeContact(handles(false), 'env-1')
    await ensureBrowserClientHostOnRuntimeContact(handles(true), 'env-1')
    expect(prepare.mock.calls.map(([request]) => request.preference)).toEqual(['auto', 'client'])
  })

  it('skips it on relaunch only for saved pages this desktop placed', async () => {
    const prepare = stubPlacementProbe()
    const saved = (remoteBrowserPagePlacedHere: boolean) => ({
      p1: [
        {
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
          browserRuntimeEnvironmentId: 'env-2',
          remoteBrowserPageId: remoteBrowserPagePlacedHere ? 'placed-page' : 'claimed-page',
          remoteBrowserPageClientHosted: true,
          remoteBrowserPagePlacedHere
        }
      ]
    })
    await ensureBrowserClientHostsForRestoredPages({
      remoteBrowserPageHandlesByPageId: buildRestoredRemoteBrowserPageHandles(saved(false))
    })
    await ensureBrowserClientHostsForRestoredPages({
      remoteBrowserPageHandlesByPageId: buildRestoredRemoteBrowserPageHandles(saved(true))
    })
    expect(prepare.mock.calls.map(([request]) => request.preference)).toEqual(['auto', 'client'])
  })
})
