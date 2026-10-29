import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { subscribeGitHubParticipantAccountsChanged } from '@/runtime/github-participant-account-changes'
import { registerProjectCatalogIpcBridge } from './project-catalog-ipc-bridge'
const initial = useAppStore.getState()
afterEach(() => {
  useAppStore.setState(initial, true)
  vi.unstubAllGlobals()
})
it('refreshes local member state and clears local GitHub cache without clearing a remote twin', async () => {
  let changed: (() => void) | undefined
  const subscribe = () => () => {}
  vi.stubGlobal('window', {
    api: {
      repos: {
        onChanged: (listener: () => void) => {
          changed = listener
          return () => {}
        }
      },
      worktrees: {
        onChanged: subscribe,
        onBaseStatus: subscribe,
        onRemoteBranchConflict: subscribe
      }
    }
  })
  useAppStore.setState({
    repos: [
      { id: 'repo', path: '/local', displayName: 'Local', badgeColor: '', addedAt: 0 },
      {
        id: 'repo',
        path: '/remote',
        displayName: 'Remote',
        badgeColor: '',
        addedAt: 0,
        executionHostId: 'runtime:server'
      }
    ],
    issueCache: {
      'repo::1': { data: null, fetchedAt: 1 },
      'runtime:server::repo::1': { data: null, fetchedAt: 1 }
    },
    fetchRepos: vi.fn(async () => {}),
    fetchProjectGroups: vi.fn(async () => {}),
    fetchFolderWorkspaces: vi.fn(async () => {})
  })
  const localRefresh = vi.fn()
  const remoteRefresh = vi.fn()
  const stopLocal = subscribeGitHubParticipantAccountsChanged({ kind: 'local' }, localRefresh)
  const stopRemote = subscribeGitHubParticipantAccountsChanged(
    { kind: 'environment', environmentId: 'server' },
    remoteRefresh
  )
  const unsubs: (() => void)[] = []
  registerProjectCatalogIpcBridge(
    unsubs,
    { enqueue: vi.fn(), dispose: vi.fn() },
    () => true,
    vi.fn()
  )
  try {
    changed?.()
    expect(localRefresh).toHaveBeenCalledOnce()
    expect(remoteRefresh).not.toHaveBeenCalled()
    expect(useAppStore.getState().issueCache).toEqual({
      'runtime:server::repo::1': { data: null, fetchedAt: 1 }
    })
    await Promise.resolve()
    await Promise.resolve()
  } finally {
    unsubs.forEach((stop) => stop())
    stopLocal()
    stopRemote()
  }
})
