import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type {
  WorktreeOperationOwnerRecord,
  WorktreeOperationRouteState
} from '@/lib/worktree-operation-route'
import {
  getPortsPanelOwnerKey,
  portsPanelHostForOwnerKey,
  type PortsPanelHost
} from './ports-panel-host'

const WORKTREE_ID = 'repo-1::/srv/w'

function worktree(
  hostId?: WorktreeOperationOwnerRecord['hostId'],
  runtimeOwnerEnvironmentId?: string
): WorktreeOperationOwnerRecord {
  return { id: WORKTREE_ID, repoId: 'repo-1', hostId, runtimeOwnerEnvironmentId }
}

function folder(executionHostId: `runtime:${string}` | 'local', connectionId?: string) {
  return {
    id: 'f1',
    projectGroupId: 'g1',
    connectionId: connectionId ?? null,
    executionHostId,
    diffComments: []
  }
}

const serverSsh = (environmentId: string, targetId: string): PortsPanelHost => ({
  kind: 'host-scoped',
  route: { target: { kind: 'environment', environmentId }, at: `ssh:${targetId}` },
  executionHostId: `ssh:${targetId}`
})

const CASES: {
  name: string
  rows: WorktreeOperationRouteState
  workspaceId?: string
  host: PortsPanelHost
}[] = [
  {
    name: 'local workspace',
    rows: { repos: [{ id: 'repo-1' }], worktreesByRepo: { 'repo-1': [worktree('local')] } },
    host: { kind: 'endpoint', target: { kind: 'local' } }
  },
  {
    name: 'direct SSH',
    rows: {
      repos: [{ id: 'repo-1', connectionId: 'box' }],
      worktreesByRepo: { 'repo-1': [worktree('ssh:box')] }
    },
    host: { kind: 'direct-ssh', connectionId: 'box' }
  },
  {
    // #24067: the repo row names no owner; only the workspace row names the VM. Recipe VM targets
    // publish no connection state, so this app's own runtime scans them.
    name: 'recipe VM workspace whose repo row names no host',
    rows: {
      repos: [{ id: 'repo-1' }],
      worktreesByRepo: { 'repo-1': [worktree('ssh:runtime-ssh-vm1')] }
    },
    host: {
      kind: 'host-scoped',
      route: { target: { kind: 'local' }, at: 'ssh:runtime-ssh-vm1' },
      executionHostId: 'ssh:runtime-ssh-vm1'
    }
  },
  {
    name: 'paired server',
    rows: {
      repos: [{ id: 'repo-1', executionHostId: 'runtime:env-a' }],
      worktreesByRepo: { 'repo-1': [worktree('runtime:env-a', 'env-a')] }
    },
    host: { kind: 'endpoint', target: { kind: 'environment', environmentId: 'env-a' } }
  },
  {
    // The repo's connectionId names the server's target, not one this client dials.
    name: 'SSH target behind a paired server, known from its repo',
    rows: {
      repos: [{ id: 'repo-1', executionHostId: 'runtime:env-a', connectionId: 't' }],
      worktreesByRepo: { 'repo-1': [worktree('runtime:env-a', 'env-a')] }
    },
    host: serverSsh('env-a', 't')
  },
  {
    name: 'SSH target behind a paired server, named by the workspace row',
    rows: { worktreesByRepo: { 'repo-1': [worktree('ssh:t', 'env-a')] } },
    host: serverSsh('env-a', 't')
  },
  {
    name: 'same ssh:t behind two servers',
    rows: {
      worktreesByRepo: { 'repo-1': [worktree('ssh:t', 'env-a'), worktree('ssh:t', 'env-b')] }
    },
    host: { kind: 'unknown' }
  },
  {
    name: 'folder workspace, local',
    rows: { folderWorkspaces: [folder('local')] },
    workspaceId: 'folder:f1',
    host: { kind: 'endpoint', target: { kind: 'local' } }
  },
  {
    name: 'folder workspace, paired server',
    rows: { folderWorkspaces: [folder('runtime:env-a')] },
    workspaceId: 'folder:f1',
    host: { kind: 'endpoint', target: { kind: 'environment', environmentId: 'env-a' } }
  },
  {
    name: 'folder workspace, SSH target behind a paired server',
    rows: { folderWorkspaces: [folder('runtime:env-a', 't')] },
    workspaceId: 'folder:f1',
    host: serverSsh('env-a', 't')
  },
  {
    name: 'floating workspace',
    rows: {},
    workspaceId: FLOATING_TERMINAL_WORKTREE_ID,
    host: { kind: 'endpoint', target: { kind: 'local' } }
  },
  {
    name: 'unknown workspace',
    rows: {},
    host: { kind: 'unknown' }
  }
]

describe('Ports panel host', () => {
  it.each(CASES)('$name, with another server as Active Server', ({ rows, workspaceId, host }) => {
    const state: WorktreeOperationRouteState = {
      ...rows,
      settings: { activeRuntimeEnvironmentId: 'env-home' },
      runtimeEnvironments: [{ id: 'env-a' }, { id: 'env-b' }, { id: 'env-home' }],
      runtimeEnvironmentCatalogHydrated: true
    }

    const key = getPortsPanelOwnerKey(state, workspaceId ?? WORKTREE_ID)

    expect(portsPanelHostForOwnerKey(key)).toEqual(host)
  })

  it('has no host without a selected workspace', () => {
    expect(portsPanelHostForOwnerKey(getPortsPanelOwnerKey({}, null))).toEqual({
      kind: 'unknown'
    })
  })
})
