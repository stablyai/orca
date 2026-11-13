// Use one twin-repo fixture for main routing and window session-partition routing.
import { getDefaultWorkspaceSession } from './constants'
import type { ExecutionHostId } from './execution-host'
import type { Repo } from './repo-types'
import type { WorkspaceSessionState } from './workspace-session/workspace-session-state-types'

export const TWIN_WORKTREE_ID = 'repo::/work/orca'

export type TwinRepoRow = Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>
export type TwinCatalogRow = {
  id: string
  repoId: string
  hostId?: ExecutionHostId
  runtimeOwnerEnvironmentId?: string
}

export const LOCAL_ROW: TwinRepoRow = { id: 'repo' }
export const SSH_ROW: TwinRepoRow = { id: 'repo', connectionId: 'box' }
export const RUNTIME_ROW: TwinRepoRow = { id: 'repo', executionHostId: 'runtime:env-1' }

function listedOn(hostId: ExecutionHostId): TwinCatalogRow {
  const row = { id: TWIN_WORKTREE_ID, repoId: 'repo', hostId }
  return hostId.startsWith('runtime:')
    ? { ...row, runtimeOwnerEnvironmentId: hostId.slice('runtime:'.length) }
    : row
}

function tabsSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [TWIN_WORKTREE_ID]: [
        {
          id: 'tab',
          ptyId: null,
          worktreeId: TWIN_WORKTREE_ID,
          title: 'shell',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    }
  }
}

/** Read local plus saved tab partitions and stale visit-only partitions. */
export function twinPartitionSessions(
  saved: readonly ExecutionHostId[],
  staleOn: readonly ExecutionHostId[] = []
): Map<ExecutionHostId, WorkspaceSessionState> {
  const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
    ['local', getDefaultWorkspaceSession()]
  ])
  for (const hostId of staleOn) {
    sessions.set(hostId, {
      ...getDefaultWorkspaceSession(),
      lastVisitedAtByWorktreeId: { [TWIN_WORKTREE_ID]: 1 }
    })
  }
  for (const hostId of saved) {
    sessions.set(hostId, tabsSession())
  }
  return sessions
}

export type TwinRepoHostCase = {
  name: string
  /** Catalog order: main's getRepo answers with the first row. */
  repos: TwinRepoRow[]
  catalog: TwinCatalogRow[]
  saved: ExecutionHostId[]
  staleOn?: ExecutionHostId[]
  expected: ExecutionHostId
}

export const TWIN_REPO_HOST_CASES: TwinRepoHostCase[] = [
  {
    name: 'a stale local visit yields to the runtime-only catalog',
    repos: [LOCAL_ROW, RUNTIME_ROW],
    catalog: [listedOn('runtime:env-1')],
    saved: [],
    staleOn: ['local'],
    expected: 'runtime:env-1'
  },
  {
    name: 'saved runtime rows survive an empty catalog',
    repos: [LOCAL_ROW, RUNTIME_ROW],
    catalog: [],
    saved: ['runtime:env-1'],
    expected: 'runtime:env-1'
  },
  {
    name: 'saved runtime wins when both catalog rows exist',
    repos: [LOCAL_ROW, RUNTIME_ROW],
    catalog: [listedOn('local'), listedOn('runtime:env-1')],
    saved: ['runtime:env-1'],
    expected: 'runtime:env-1'
  },
  {
    name: 'a local-only catalog contradicts saved runtime rows',
    repos: [RUNTIME_ROW, LOCAL_ROW],
    catalog: [listedOn('local')],
    saved: ['runtime:env-1'],
    expected: 'local'
  },
  {
    name: 'contested local and runtime claims use local primary',
    repos: [RUNTIME_ROW, LOCAL_ROW],
    catalog: [listedOn('runtime:env-1'), listedOn('local')],
    saved: ['runtime:env-1', 'local'],
    expected: 'local'
  },
  {
    name: 'contested SSH and runtime catalog rows use SSH primary',
    repos: [RUNTIME_ROW, SSH_ROW],
    catalog: [listedOn('runtime:env-1'), listedOn('ssh:box')],
    saved: [],
    expected: 'ssh:box'
  },
  {
    name: 'a lone SSH catalog row does not displace local fallback',
    repos: [SSH_ROW, LOCAL_ROW],
    catalog: [listedOn('ssh:box')],
    saved: [],
    expected: 'local'
  },
  {
    name: 'unknown ownership falls back locally regardless of repo order',
    repos: [RUNTIME_ROW, LOCAL_ROW],
    catalog: [],
    saved: [],
    expected: 'local'
  }
]
