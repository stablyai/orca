// Use one twin-repo fixture for main routing and window session-partition routing.
import { getDefaultWorkspaceSession } from './constants'
import type { ExecutionHostId } from './execution-host'
import type { Repo } from './repo-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'

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

const PAIRS: [
  string,
  TwinRepoRow,
  ExecutionHostId,
  ExecutionHostId,
  TwinRepoRow,
  ExecutionHostId,
  ExecutionHostId,
  ExecutionHostId
][] = [
  ['local+ssh', LOCAL_ROW, 'local', 'local', SSH_ROW, 'ssh:box', 'local', 'local'],
  [
    'local+runtime',
    LOCAL_ROW,
    'local',
    'local',
    RUNTIME_ROW,
    'runtime:env-1',
    'runtime:env-1',
    'local'
  ],
  [
    'ssh+runtime',
    SSH_ROW,
    'ssh:box',
    'local',
    RUNTIME_ROW,
    'runtime:env-1',
    'runtime:env-1',
    'ssh:box'
  ]
]

const GENERATED_CASES: TwinRepoHostCase[] = PAIRS.flatMap(
  ([pair, rowA, hostA, expectedA, rowB, hostB, expectedB, contested]) => {
    // Test both catalog orders to reject first-row routing.
    const orders = [
      [rowB, rowA],
      [rowA, rowB]
    ]
    const holdings: [string, ExecutionHostId[], ExecutionHostId][] = [
      ['contested', [hostA, hostB], contested],
      [`${hostA} only`, [hostA], expectedA],
      [`${hostB} only`, [hostB], expectedB],
      ['unknown', [], 'local']
    ]
    return orders.flatMap((repos, order) =>
      holdings.flatMap(([holding, hosts, expected]) => {
        const catalog = hosts.map(listedOn)
        return [
          { name: `${pair} #${order} ${holding}, fresh`, repos, catalog, saved: [], expected },
          {
            name: `${pair} #${order} ${holding}, saved`,
            repos,
            catalog,
            saved: [expected],
            expected
          }
        ]
      })
    )
  }
)

export const TWIN_REPO_HOST_CASES: TwinRepoHostCase[] = [
  ...GENERATED_CASES,
  {
    name: 'local+runtime: a stale local visit stamp yields to a runtime-only catalog',
    repos: [LOCAL_ROW, RUNTIME_ROW],
    catalog: [listedOn('runtime:env-1')],
    saved: [],
    staleOn: ['local'],
    expected: 'runtime:env-1'
  },
  {
    name: 'local+runtime: rows saved on runtime with nothing listed stay on runtime',
    repos: [LOCAL_ROW, RUNTIME_ROW],
    catalog: [],
    saved: ['runtime:env-1'],
    expected: 'runtime:env-1'
  }
]
