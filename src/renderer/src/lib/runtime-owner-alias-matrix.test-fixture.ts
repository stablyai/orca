/** Owner-resolution cases spanning every branch: local, direct SSH, runtime, HUB-proxied SSH, twins. */
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'

export type OwnerResolutionCase = {
  name: string
  state: WorktreeRuntimeOwnerState
  worktreeId: string | null
}

const base: WorktreeRuntimeOwnerState = {
  settings: { activeRuntimeEnvironmentId: 'focused-env' },
  runtimeEnvironments: [{ id: 'focused-env' }, { id: 'owner-env' }, { id: 'hub-env' }],
  runtimeEnvironmentCatalogHydrated: true,
  repos: [
    { id: 'local-repo', connectionId: null, executionHostId: 'local' },
    { id: 'legacy-repo', connectionId: null, executionHostId: null },
    { id: 'runtime-repo', connectionId: null, executionHostId: 'runtime:owner-env' },
    { id: 'ssh-repo', connectionId: 'box', executionHostId: 'ssh:box' },
    { id: 'hub-repo', connectionId: 'box', executionHostId: 'runtime:hub-env' },
    { id: 'twin-repo', connectionId: null, executionHostId: 'local' },
    { id: 'twin-repo', connectionId: 'box', executionHostId: 'ssh:box' },
    { id: 'repo-twin-only', connectionId: null, executionHostId: 'local' },
    { id: 'repo-twin-only', connectionId: null, executionHostId: 'runtime:owner-env' },
    { id: 'stale-hub-repo', connectionId: 'target', executionHostId: 'runtime:hub-env' },
    { id: 'conflict-repo', connectionId: 'box', executionHostId: 'runtime:hub-a' },
    { id: 'conflict-repo', connectionId: 'box', executionHostId: 'runtime:hub-b' }
  ],
  worktreesByRepo: {
    'local-repo': [{ id: 'local-repo::wt', repoId: 'local-repo', hostId: 'local' }],
    'legacy-repo': [{ id: 'legacy-repo::wt', repoId: 'legacy-repo' }],
    'runtime-repo': [{ id: 'runtime-repo::wt', repoId: 'runtime-repo' }],
    'ssh-repo': [{ id: 'ssh-repo::wt', repoId: 'ssh-repo', hostId: 'ssh:box' }],
    'hub-repo': [
      {
        id: 'hub-repo::wt',
        repoId: 'hub-repo',
        hostId: 'ssh:box',
        runtimeOwnerEnvironmentId: 'hub-env'
      }
    ],
    'twin-repo': [
      { id: 'twin-repo::wt', repoId: 'twin-repo', hostId: 'local' },
      { id: 'twin-repo::wt', repoId: 'twin-repo', hostId: 'ssh:box' }
    ],
    'repo-twin-only': [{ id: 'repo-twin-only::wt', repoId: 'repo-twin-only' }],
    // A publication that lost its HUB stamp; the repo setup still names the transport.
    'stale-hub-repo': [
      { id: 'stale-hub-repo::wt', repoId: 'stale-hub-repo', hostId: 'ssh:target' }
    ],
    'rival-repo': [
      {
        id: 'rival-repo::wt',
        repoId: 'rival-repo',
        hostId: 'ssh:box',
        runtimeOwnerEnvironmentId: 'hub-a'
      },
      {
        id: 'rival-repo::wt',
        repoId: 'rival-repo',
        hostId: 'ssh:box',
        runtimeOwnerEnvironmentId: 'hub-b'
      }
    ],
    // One row offers a HUB transport; a detected copy and two HUB repo setups contradict it.
    'conflict-repo': [
      {
        id: 'conflict-repo::wt',
        repoId: 'conflict-repo',
        hostId: 'ssh:box',
        runtimeOwnerEnvironmentId: 'hub-a'
      }
    ],
    'projected-twin': [
      { id: 'projected-twin::wt', repoId: 'projected-twin', runtimeOwnerEnvironmentId: 'hub-a' },
      { id: 'projected-twin::wt', repoId: 'projected-twin', runtimeOwnerEnvironmentId: 'hub-b' }
    ]
  },
  detectedWorktreesByRepo: {
    'conflict-repo': {
      worktrees: [{ id: 'conflict-repo::wt', repoId: 'conflict-repo', hostId: 'ssh:box' }]
    },
    'detected-repo': {
      worktrees: [{ id: 'detected-repo::wt', repoId: 'detected-repo', hostId: 'runtime:owner-env' }]
    }
  },
  projectGroups: [
    { id: 'local-group', connectionId: null, executionHostId: 'local' },
    { id: 'runtime-group', connectionId: 'inner-ssh', executionHostId: 'runtime:owner-env' },
    { id: 'twin-group', connectionId: null, executionHostId: 'local' },
    { id: 'twin-group', connectionId: 'box', executionHostId: 'ssh:box' }
  ],
  folderWorkspaces: [
    { id: 'local-folder', projectGroupId: 'local-group' },
    { id: 'runtime-folder', projectGroupId: 'runtime-group' },
    { id: 'ssh-folder', projectGroupId: 'no-such-group', connectionId: 'box' },
    { id: 'twin-folder', projectGroupId: 'local-group', executionHostId: 'local' },
    {
      id: 'twin-folder',
      projectGroupId: 'local-group',
      executionHostId: 'ssh:box',
      connectionId: 'box'
    },
    { id: 'group-twin-folder', projectGroupId: 'twin-group' },
    { id: 'unstamped-folder', projectGroupId: 'no-such-group' }
  ],
  restoredRuntimeHostIdByWorkspaceSessionKey: { 'folder:restored-folder': 'runtime:owner-env' }
}

const ids = [
  null,
  FLOATING_TERMINAL_WORKTREE_ID,
  'local-repo::wt',
  'legacy-repo::wt',
  'runtime-repo::wt',
  'ssh-repo::wt',
  'hub-repo::wt',
  'twin-repo::wt',
  'repo-twin-only::wt',
  'stale-hub-repo::wt',
  'rival-repo::wt',
  'projected-twin::wt',
  'detected-repo::wt',
  'unknown-repo::wt',
  'folder:local-folder',
  'folder:runtime-folder',
  'folder:ssh-folder',
  'folder:twin-folder',
  'folder:group-twin-folder',
  'folder:unstamped-folder',
  'folder:restored-folder',
  'folder:missing-folder'
]

const noFocus: WorktreeRuntimeOwnerState = { ...base, settings: null, runtimeEnvironments: [] }
// Why: the legacy single-runtime fallback only fires with exactly one saved, focused runtime.
const singleFocus: WorktreeRuntimeOwnerState = {
  ...base,
  runtimeEnvironments: [{ id: 'focused-env' }]
}

export const OWNER_RESOLUTION_CASES: readonly OwnerResolutionCase[] = [
  ...ids.map((worktreeId) => ({ name: `focused | ${worktreeId}`, state: base, worktreeId })),
  ...ids.map((worktreeId) => ({ name: `no focus | ${worktreeId}`, state: noFocus, worktreeId })),
  ...ids.map((worktreeId) => ({
    name: `single focus | ${worktreeId}`,
    state: singleFocus,
    worktreeId
  })),
  ...[
    'twin-repo::wt',
    'rival-repo::wt',
    'conflict-repo::wt',
    'folder:twin-folder',
    'folder:group-twin-folder'
  ].flatMap((worktreeId) =>
    (['local', 'ssh:box'] as const).map((host) => ({
      name: `active ${host} | ${worktreeId}`,
      state: { ...base, activeWorktreeId: worktreeId, activeWorkspaceExecutionHostId: host },
      worktreeId
    }))
  )
]
