// Load each renderer client OS against a real one-workspace store; suites own their vi.mock declarations.
import { vi } from 'vitest'
import type * as StoreHelpersNamespace from '@/store/slices/store-test-helpers'
import type * as CapabilitiesNamespace from '@/runtime/local-runtime-capabilities'
import {
  LAUNCH_FOLDER_ID,
  LAUNCH_REPO_ID,
  launchWorkspaceId,
  type LaunchClient,
  type LaunchWorkspace
} from '../../../shared/launch-parity-window-request.test-fixture'

const USER_AGENT: Record<LaunchClient, string> = {
  darwin: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Orca',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) Orca',
  win32: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Orca'
}

type StoreHelpers = typeof StoreHelpersNamespace
export type LaunchTestStore = ReturnType<StoreHelpers['createTestStore']>

/** Hoist with vi.hoisted so the `@/store` mock and the suite share the live store. */
export type LaunchStoreHolder = { store: LaunchTestStore | null }

export function launchStoreModuleMock(holder: LaunchStoreHolder): Record<string, unknown> {
  const live = (): LaunchTestStore => {
    if (!holder.store) {
      throw new Error('launch-parity store not seeded')
    }
    return holder.store
  }
  return {
    useAppStore: {
      getState: () => live().getState(),
      setState: (...args: Parameters<LaunchTestStore['setState']>) => live().setState(...args),
      subscribe: (...args: Parameters<LaunchTestStore['subscribe']>) => live().subscribe(...args)
    }
  }
}

/** Load a fresh graph per OS because CLIENT_PLATFORM and renderer platform cache import-time user-agent answers. */
export function perClientLoader<T>(
  load: () => Promise<T>
): (client: LaunchClient) => Promise<T & { createStore: StoreHelpers['createTestStore'] }> {
  const cache = new Map<LaunchClient, T & { createStore: StoreHelpers['createTestStore'] }>()
  return async (client) => {
    vi.stubGlobal('navigator', { userAgent: USER_AGENT[client] })
    const cached = cache.get(client)
    if (cached) {
      return cached
    }
    vi.resetModules()
    const helpers: StoreHelpers = await import('@/store/slices/store-test-helpers')
    const capabilities: typeof CapabilitiesNamespace =
      await import('@/runtime/local-runtime-capabilities')
    capabilities.setLocalRuntimeCapabilitiesForTests([])
    const loaded = { ...(await load()), createStore: helpers.createTestStore }
    cache.set(client, loaded)
    return loaded
  }
}

export function launchWorkspaceState(
  workspace: LaunchWorkspace,
  settings: Record<string, unknown>
): Record<string, unknown> {
  const repoPath = workspace.kind === 'repo' ? workspace.path : workspace.repoPath
  const repo = repoPath
    ? {
        id: LAUNCH_REPO_ID,
        path: repoPath,
        displayName: 'repo',
        badgeColor: '#000000',
        addedAt: 0,
        kind: 'git',
        connectionId: null,
        executionHostId: 'local'
      }
    : null
  const worktree = {
    id: `${LAUNCH_REPO_ID}::${repoPath}`,
    repoId: LAUNCH_REPO_ID,
    path: repoPath,
    hostId: 'local',
    head: 'abc',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
    displayName: 'wt',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
  return {
    settings,
    repos: repo ? [repo] : [],
    projects: repo
      ? [
          {
            id: LAUNCH_REPO_ID,
            displayName: 'repo',
            badgeColor: '#000000',
            sourceRepoIds: [LAUNCH_REPO_ID],
            createdAt: 0,
            updatedAt: 0,
            ...(workspace.projectRuntime
              ? { localWindowsRuntimePreference: workspace.projectRuntime }
              : {})
          }
        ]
      : [],
    worktreesByRepo: repo ? { [LAUNCH_REPO_ID]: [worktree] } : {},
    folderWorkspaces:
      workspace.kind === 'folder'
        ? [
            {
              id: LAUNCH_FOLDER_ID.slice('folder:'.length),
              projectGroupId: 'pg-1',
              name: 'folder',
              folderPath: workspace.path,
              connectionId: null,
              linkedTask: null,
              comment: '',
              isArchived: false,
              isUnread: false,
              isPinned: false,
              sortOrder: 0,
              lastActivityAt: 0,
              createdAt: 0,
              updatedAt: 0
            }
          ]
        : [],
    projectGroups: [{ id: 'pg-1', name: 'group', parentPath: null, parentGroupId: null }],
    activeWorktreeId: launchWorkspaceId(workspace)
  }
}
