import { beforeEach, describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { HostAuthority } from '../../../shared/host-authority'
import type { ExecutionHostOwnerMatch } from '../../../shared/worktree-execution-host-resolution'
import {
  getLegacyFocusFallbackCount,
  resetLegacyFocusFallbackCountForTest,
  resolveOwner,
  resolveOwnerWithLegacyFocus,
  type WorkspaceOwnerRef
} from './resolve-owner'
import type {
  WorktreeOperationOwnerRecord,
  WorktreeOperationRouteState
} from './worktree-operation-route'

const WORKTREE_ID = 'repo-1::/srv/w'

type Match = ExecutionHostOwnerMatch<HostAuthority>
const missing: Match = { kind: 'missing' }
const ambiguous: Match = { kind: 'ambiguous' }
const selfAt = (at: HostAuthority['at']): Match => ({
  kind: 'resolved',
  owner: { endpoint: { kind: 'self' }, at }
})
const envAt = (environmentId: string, at: HostAuthority['at'] = 'local'): Match => ({
  kind: 'resolved',
  owner: { endpoint: { kind: 'environment', environmentId }, at }
})

function worktree(
  hostId?: WorktreeOperationOwnerRecord['hostId'],
  runtimeOwnerEnvironmentId?: string
): WorktreeOperationOwnerRecord {
  return { id: WORKTREE_ID, repoId: 'repo-1', hostId, runtimeOwnerEnvironmentId }
}

function folder(executionHostId: `runtime:${string}` | 'local' | null, connectionId?: string) {
  return {
    id: 'f1',
    projectGroupId: 'g1',
    connectionId: connectionId ?? null,
    executionHostId,
    diffComments: []
  }
}

type ActiveServer = 'local' | 'other' | 'deleted'
const ACTIVE_SERVERS: readonly ActiveServer[] = ['local', 'other', 'deleted']
const FOCUS: Record<ActiveServer, string | null> = {
  local: null,
  other: 'env-other',
  deleted: 'env-gone'
}
const SAVED_SERVERS = ['env-a', 'env-b', 'env-orcad', 'env-other']

type Row = {
  name: string
  rows: WorktreeOperationRouteState
  ref: WorkspaceOwnerRef
  owner: Match
  /** Today's focus-reading answer where it differs from `owner`. */
  legacy?: Partial<Record<ActiveServer, Match>>
  savedServers?: string[]
}

const ROWS: Row[] = [
  {
    name: 'local, stamped',
    rows: { repos: [{ id: 'repo-1' }], worktreesByRepo: { 'repo-1': [worktree('local')] } },
    ref: { workspaceId: WORKTREE_ID },
    owner: selfAt('local')
  },
  {
    name: 'local, unstamped legacy row',
    rows: { repos: [{ id: 'repo-1' }], worktreesByRepo: { 'repo-1': [worktree()] } },
    ref: { workspaceId: WORKTREE_ID },
    owner: selfAt('local'),
    legacy: { other: missing, deleted: missing }
  },
  {
    name: 'local, unstamped legacy row, one saved server',
    rows: { repos: [{ id: 'repo-1' }], worktreesByRepo: { 'repo-1': [worktree()] } },
    ref: { workspaceId: WORKTREE_ID },
    owner: selfAt('local'),
    savedServers: ['env-other'],
    legacy: { other: envAt('env-other'), deleted: missing }
  },
  {
    name: 'direct SSH',
    rows: {
      repos: [{ id: 'repo-1', connectionId: 'box' }],
      worktreesByRepo: { 'repo-1': [worktree('ssh:box')] }
    },
    ref: { workspaceId: WORKTREE_ID },
    owner: selfAt('ssh:box')
  },
  {
    name: 'managed server on an SSH host keeps its own id',
    rows: {
      repos: [{ id: 'repo-1', executionHostId: 'runtime:env-orcad' }],
      worktreesByRepo: { 'repo-1': [worktree('runtime:env-orcad', 'env-orcad')] }
    },
    ref: { workspaceId: WORKTREE_ID },
    owner: envAt('env-orcad')
  },
  {
    name: 'paired server',
    rows: {
      repos: [{ id: 'repo-1', executionHostId: 'runtime:env-a' }],
      worktreesByRepo: { 'repo-1': [worktree('runtime:env-a', 'env-a')] }
    },
    ref: { workspaceId: WORKTREE_ID },
    owner: envAt('env-a')
  },
  {
    name: 'SSH target behind a paired server',
    rows: { worktreesByRepo: { 'repo-1': [worktree('ssh:t', 'env-a')] } },
    ref: { workspaceId: WORKTREE_ID },
    owner: envAt('env-a', 'ssh:t')
  },
  {
    name: 'SSH target behind a paired server, row names the host',
    rows: { worktreesByRepo: { 'repo-1': [worktree('ssh:t', 'env-a')] } },
    ref: { workspaceId: WORKTREE_ID, hostId: 'ssh:t' },
    owner: envAt('env-a', 'ssh:t')
  },
  {
    name: 'SSH target behind a paired server, known only from its repo',
    rows: {
      repos: [{ id: 'repo-1', executionHostId: 'runtime:env-a', connectionId: 't' }],
      worktreesByRepo: { 'repo-1': [worktree('runtime:env-a', 'env-a')] }
    },
    ref: { workspaceId: WORKTREE_ID },
    owner: envAt('env-a', 'ssh:t')
  },
  {
    name: 'same ssh:t behind two servers',
    rows: {
      worktreesByRepo: { 'repo-1': [worktree('ssh:t', 'env-a'), worktree('ssh:t', 'env-b')] }
    },
    ref: { workspaceId: WORKTREE_ID },
    owner: ambiguous
  },
  {
    name: 'same ssh:t behind two servers, row names the host',
    rows: {
      worktreesByRepo: { 'repo-1': [worktree('ssh:t', 'env-a'), worktree('ssh:t', 'env-b')] }
    },
    ref: { workspaceId: WORKTREE_ID, hostId: 'ssh:t' },
    owner: ambiguous
  },
  {
    name: 'same ssh:t behind two servers, selected as the active workspace',
    rows: {
      worktreesByRepo: { 'repo-1': [worktree('ssh:t', 'env-a'), worktree('ssh:t', 'env-b')] },
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: 'ssh:t'
    },
    ref: { workspaceId: WORKTREE_ID },
    owner: ambiguous
  },
  {
    name: 'recipe VM SSH target',
    rows: {
      repos: [{ id: 'repo-1', connectionId: 'runtime-ssh-vm1' }],
      worktreesByRepo: { 'repo-1': [worktree('ssh:runtime-ssh-vm1')] }
    },
    ref: { workspaceId: WORKTREE_ID },
    owner: selfAt('ssh:runtime-ssh-vm1')
  },
  {
    name: 'floating workspace',
    rows: {},
    ref: { workspaceId: FLOATING_TERMINAL_WORKTREE_ID },
    owner: selfAt('local')
  },
  {
    name: 'folder, local',
    rows: { folderWorkspaces: [folder('local')] },
    ref: { workspaceId: 'folder:f1' },
    owner: selfAt('local')
  },
  {
    name: 'folder, paired server',
    rows: { folderWorkspaces: [folder('runtime:env-a')] },
    ref: { workspaceId: 'folder:f1' },
    owner: envAt('env-a')
  },
  {
    name: 'folder, SSH target behind a paired server',
    rows: { folderWorkspaces: [folder('runtime:env-a', 't')] },
    ref: { workspaceId: 'folder:f1' },
    owner: envAt('env-a', 'ssh:t')
  },
  {
    name: 'folder, SSH target behind a paired server, stamped on its group',
    rows: {
      folderWorkspaces: [folder(null)],
      projectGroups: [{ id: 'g1', connectionId: 't', executionHostId: 'runtime:env-a' }]
    },
    ref: { workspaceId: 'folder:f1' },
    owner: envAt('env-a', 'ssh:t')
  },
  {
    name: 'folder, unstamped, one saved server',
    rows: { folderWorkspaces: [folder(null)] },
    ref: { workspaceId: 'folder:f1' },
    owner: selfAt('local'),
    savedServers: ['env-other'],
    legacy: { other: envAt('env-other') }
  },
  {
    name: 'unknown id',
    rows: {},
    ref: { workspaceId: WORKTREE_ID },
    owner: missing
  }
]

function withActiveServer(row: Row, active: ActiveServer): WorktreeOperationRouteState {
  return {
    ...row.rows,
    settings: { activeRuntimeEnvironmentId: FOCUS[active] },
    runtimeEnvironments: (row.savedServers ?? SAVED_SERVERS).map((id) => ({ id })),
    runtimeEnvironmentCatalogHydrated: true
  }
}

describe('resolveOwner characterization', () => {
  beforeEach(() => resetLegacyFocusFallbackCountForTest())

  describe.each(ROWS)('$name', (row) => {
    it.each(ACTIVE_SERVERS)('Active Server = %s', (active) => {
      const state = withActiveServer(row, active)
      expect(resolveOwner(state, row.ref)).toEqual(row.owner)

      const legacy = row.legacy?.[active]
      expect(resolveOwnerWithLegacyFocus(state, row.ref)).toEqual(legacy ?? row.owner)
      expect(getLegacyFocusFallbackCount()).toBe(legacy ? 1 : 0)
    })
  })
})
