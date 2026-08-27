import type * as ReactModule from 'react'
import { describe, expect, it, vi } from 'vitest'

describe('runtime host catalog refresh on reposChanged', () => {
  // Why: the host emits one reposChanged for project-group and folder-workspace edits
  // too, so a repos-only refresh leaves those catalogs stale on every paired client.
  it('refetches the runtime host project group and folder workspace catalogs', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    try {
      const calls: string[] = []
      const fetchRuntimeEnvironmentRepos = vi.fn(() => {
        calls.push('repos')
        return Promise.resolve([])
      })
      const fetchProjectGroups = vi.fn(() => {
        calls.push('project-groups')
        return Promise.resolve()
      })
      const fetchFolderWorkspaces = vi.fn(() => {
        calls.push('folder-workspaces')
        return Promise.resolve()
      })
      const state = {
        settings: { activeRuntimeEnvironmentId: 'env-1' as string | null },
        repos: [],
        worktreesByRepo: {},
        folderWorkspaces: [],
        projectGroups: [],
        runtimeEnvironments: [],
        runtimeStatusByEnvironmentId: new Map(),
        tabsByWorktree: {},
        ptyIdsByTabId: {},
        remountTerminalTabForRecovery: vi.fn(),
        markEnvironmentSshStateStale: vi.fn(),
        fetchRepos: vi.fn(() => Promise.resolve()),
        fetchRuntimeEnvironmentRepos,
        fetchProjectGroups,
        fetchFolderWorkspaces,
        fetchWorktrees: vi.fn(() => Promise.resolve()),
        fetchWorktreeLineage: vi.fn(() => Promise.resolve())
      }

      vi.doMock('react', async () => {
        const actual = await vi.importActual<typeof ReactModule>('react')
        return { ...actual, useEffect: (effect: () => void | (() => void)) => void effect() }
      })
      vi.doMock('../store', () => ({
        useAppStore: { subscribe: vi.fn(() => () => {}), getState: () => state }
      }))
      const noopListener = (): (() => void) => () => {}
      const autoStubNamespace = new Proxy(
        {},
        {
          get:
            () =>
            (...args: unknown[]) => {
              if (typeof args[0] === 'function') {
                return noopListener()
              }
              return new Promise(() => {})
            }
        }
      )
      let runtimeOnResponse: ((response: unknown) => void) | undefined
      const api = new Proxy(
        {
          runtimeEnvironments: {
            subscribe: async (_args: unknown, callbacks: { onResponse: (r: unknown) => void }) => {
              runtimeOnResponse = callbacks.onResponse
              return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
            }
          }
        } as Record<string, unknown>,
        { get: (target, prop: string) => target[prop] ?? autoStubNamespace }
      )
      vi.stubGlobal('window', { api })

      const { useIpcEvents } = await import('./useIpcEvents')
      useIpcEvents()
      // Seeded discovery for the connected runtime; drains the scheduler's debounce.
      await vi.advanceTimersByTimeAsync(300)

      const runtimeOwner = { runtimeEnvironmentId: 'env-1' }
      expect(fetchProjectGroups).toHaveBeenCalledWith(runtimeOwner)
      expect(fetchFolderWorkspaces).toHaveBeenCalledWith(runtimeOwner)
      // Folder workspaces resolve their owning group from projectGroups, so groups must land first.
      expect(calls).toEqual(['repos', 'project-groups', 'folder-workspaces'])

      calls.length = 0
      fetchProjectGroups.mockClear()
      fetchFolderWorkspaces.mockClear()
      if (!runtimeOnResponse) {
        throw new Error('Expected runtime client event callbacks')
      }
      // Past the scheduler's min interval so the event schedules on the debounce alone.
      await vi.advanceTimersByTimeAsync(5_000)
      runtimeOnResponse({ ok: true, result: { type: 'reposChanged' } })
      await vi.advanceTimersByTimeAsync(300)

      expect(fetchProjectGroups).toHaveBeenCalledWith(runtimeOwner)
      expect(fetchFolderWorkspaces).toHaveBeenCalledWith(runtimeOwner)
      expect(calls).toEqual(['repos', 'project-groups', 'folder-workspaces'])
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: the catalog fetches carry 15s RPC timeouts; serializing them ahead of the
  // worktree refresh stalled lineage convergence for 30s on a connected-but-wedged host.
  it('refreshes worktrees and lineage without waiting on a stalled catalog fetch', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    try {
      const fetchRuntimeEnvironmentRepos = vi.fn(() => Promise.resolve([{ id: 'repo-1' }]))
      // Never settles, standing in for a host that accepted the connection but stopped answering.
      const fetchProjectGroups = vi.fn(() => new Promise<void>(() => {}))
      const fetchFolderWorkspaces = vi.fn(() => Promise.resolve())
      const fetchWorktrees = vi.fn(() => Promise.resolve())
      const fetchWorktreeLineage = vi.fn(() => Promise.resolve())
      const state = {
        settings: { activeRuntimeEnvironmentId: 'env-1' as string | null },
        repos: [],
        worktreesByRepo: {},
        folderWorkspaces: [],
        projectGroups: [],
        runtimeEnvironments: [],
        runtimeStatusByEnvironmentId: new Map(),
        tabsByWorktree: {},
        ptyIdsByTabId: {},
        remountTerminalTabForRecovery: vi.fn(),
        markEnvironmentSshStateStale: vi.fn(),
        fetchRepos: vi.fn(() => Promise.resolve()),
        fetchRuntimeEnvironmentRepos,
        fetchProjectGroups,
        fetchFolderWorkspaces,
        fetchWorktrees,
        fetchWorktreeLineage
      }

      vi.doMock('react', async () => {
        const actual = await vi.importActual<typeof ReactModule>('react')
        return { ...actual, useEffect: (effect: () => void | (() => void)) => void effect() }
      })
      vi.doMock('../store', () => ({
        useAppStore: { subscribe: vi.fn(() => () => {}), getState: () => state }
      }))
      const noopListener = (): (() => void) => () => {}
      const autoStubNamespace = new Proxy(
        {},
        {
          get:
            () =>
            (...args: unknown[]) => {
              if (typeof args[0] === 'function') {
                return noopListener()
              }
              return new Promise(() => {})
            }
        }
      )
      const api = new Proxy({} as Record<string, unknown>, {
        get: (target, prop: string) => target[prop] ?? autoStubNamespace
      })
      vi.stubGlobal('window', { api })

      const { useIpcEvents } = await import('./useIpcEvents')
      useIpcEvents()
      await vi.advanceTimersByTimeAsync(300)

      expect(fetchProjectGroups).toHaveBeenCalled()
      // Folder workspaces still wait on their groups; worktrees and lineage must not.
      expect(fetchFolderWorkspaces).not.toHaveBeenCalled()
      expect(fetchWorktrees).toHaveBeenCalledWith('repo-1', expect.anything())
      expect(fetchWorktreeLineage).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('repo catalog refresh on repos:changed', () => {
  it('skips remote catalog RPCs when refreshing local rows under a runtime', async () => {
    vi.resetModules()
    let reposChangedListener: (() => void) | undefined
    const fetchRepos = vi.fn(() => Promise.resolve())
    const fetchProjectGroups = vi.fn(() => Promise.resolve())
    const fetchFolderWorkspaces = vi.fn(() => Promise.resolve())
    const remountTerminalTabForRecovery = vi.fn(() => true)
    const state = {
      settings: { activeRuntimeEnvironmentId: null as string | null },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      worktreesByRepo: { repo1: [{ id: 'wt-1', repoId: 'repo1' }] },
      folderWorkspaces: [],
      projectGroups: [],
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      ptyIdsByTabId: {},
      remountTerminalTabForRecovery,
      fetchRepos,
      fetchProjectGroups,
      fetchFolderWorkspaces
    }

    vi.doMock('react', async () => {
      const actual = await vi.importActual<typeof ReactModule>('react')
      return { ...actual, useEffect: (effect: () => void | (() => void)) => void effect() }
    })
    vi.doMock('../store', () => ({
      useAppStore: { subscribe: vi.fn(() => () => {}), getState: () => state }
    }))
    const noopListener = (): (() => void) => () => {}
    const autoStubNamespace = new Proxy(
      {},
      {
        get:
          () =>
          (...args: unknown[]) => {
            if (typeof args[0] === 'function') {
              return noopListener()
            }
            return new Promise(() => {})
          }
      }
    )
    const api = new Proxy(
      {
        repos: {
          onChanged: (listener: () => void) => {
            reposChangedListener = listener
            return () => {}
          }
        }
      } as Record<string, unknown>,
      { get: (target, prop: string) => target[prop] ?? autoStubNamespace }
    )
    vi.stubGlobal('window', { api })

    const { recordTerminalTabParkedOnUnresolvedHost, clearTerminalTabsParkedOnUnresolvedHost } =
      await import('@/lib/parked-terminal-host-hydration')
    clearTerminalTabsParkedOnUnresolvedHost()

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    state.settings.activeRuntimeEnvironmentId = 'env-1'
    // Why: the local-slice refresh still has to release panes that parked on an unhydrated host.
    recordTerminalTabParkedOnUnresolvedHost('wt-1', 'tab-1')
    reposChangedListener?.()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const localOwner = { runtimeEnvironmentId: null }
    expect(fetchRepos).toHaveBeenCalledWith(localOwner)
    expect(fetchProjectGroups).toHaveBeenCalledWith(localOwner)
    expect(fetchFolderWorkspaces).toHaveBeenCalledWith(localOwner)
    expect(remountTerminalTabForRecovery).toHaveBeenCalledWith('tab-1')
    clearTerminalTabsParkedOnUnresolvedHost()
  })
})

describe('parked terminal recovery on repos:changed', () => {
  it('remounts a pane that parked on an unresolved host once repos hydrate', async () => {
    vi.resetModules()
    const remountTerminalTabForRecovery = vi.fn(() => true)
    let reposChangedListener: (() => void) | undefined

    const state = {
      settings: { activeRuntimeEnvironmentId: null },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      worktreesByRepo: { repo1: [{ id: 'wt-1', repoId: 'repo1' }] },
      folderWorkspaces: [],
      projectGroups: [],
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      ptyIdsByTabId: {},
      remountTerminalTabForRecovery,
      fetchRepos: vi.fn(() => Promise.resolve()),
      fetchProjectGroups: vi.fn(() => Promise.resolve()),
      fetchFolderWorkspaces: vi.fn(() => Promise.resolve())
    }

    vi.doMock('react', async () => {
      const actual = await vi.importActual<typeof ReactModule>('react')
      return { ...actual, useEffect: (effect: () => void | (() => void)) => void effect() }
    })
    vi.doMock('../store', () => ({
      useAppStore: { subscribe: vi.fn(() => () => {}), getState: () => state }
    }))
    // Why: this hook registers dozens of IPC namespaces at mount; auto-stub every
    // unspecified listener so the test asserts the repos:changed wiring, not the mock surface.
    const noopListener = (): (() => void) => () => {}
    const autoStubNamespace = new Proxy(
      {},
      {
        get:
          () =>
          (...args: unknown[]) => {
            const maybeCallback = args[0]
            if (typeof maybeCallback === 'function') {
              return noopListener()
            }
            // Why: a resolving promise would run the hook's .then() handlers against
            // store setters this test does not model, surfacing as unhandled rejections
            // that Vitest flags as possible false positives. A pending promise leaves
            // those unrelated paths dormant.
            return new Promise(() => {})
          }
      }
    )
    const api = new Proxy(
      {
        repos: {
          onChanged: (cb: () => void) => {
            reposChangedListener = cb
            return () => {}
          }
        }
      } as Record<string, unknown>,
      {
        get: (target, prop: string) => target[prop] ?? autoStubNamespace
      }
    )
    vi.stubGlobal('window', { api })

    const { recordTerminalTabParkedOnUnresolvedHost, clearTerminalTabsParkedOnUnresolvedHost } =
      await import('@/lib/parked-terminal-host-hydration')
    clearTerminalTabsParkedOnUnresolvedHost()

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    expect(reposChangedListener).toBeDefined()

    // No parked pane yet: a refresh must not remount anything.
    reposChangedListener?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(remountTerminalTabForRecovery).not.toHaveBeenCalled()

    // The pane parks (its repo row had not merged when it mounted), then repos land.
    recordTerminalTabParkedOnUnresolvedHost('wt-1', 'tab-1')
    reposChangedListener?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(remountTerminalTabForRecovery).toHaveBeenCalledWith('tab-1')
    clearTerminalTabsParkedOnUnresolvedHost()
  })
})
