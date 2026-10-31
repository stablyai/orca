import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type {
  WorktreeOperationOwnerRecord,
  WorktreeOperationRouteState
} from '@/lib/worktree-operation-route'
import {
  getPortsPanelOwnerKey,
  portsPanelForwardTargetId,
  portsPanelHostForOwnerKey,
  portsPanelReachesSshHost,
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
    // Recipe VMs lack connection state; workspace ownership directs this app's scan even without repo ownership (#24067).
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

describe('Ports tab visibility', () => {
  const managed = {
    id: 'env-managed',
    orcadDeployment: { sshTargetId: 'box', sshTargetGeneration: 1 }
  } as const
  const environments = [{ id: 'env-paired' }, managed]

  it.each<[string, PortsPanelHost, boolean]>([
    ['a direct SSH workspace', { kind: 'direct-ssh', connectionId: 'box' }, true],
    ['an SSH target behind a paired server', serverSsh('env-paired', 't'), true],
    [
      'a workspace on a managed server reached over SSH',
      { kind: 'endpoint', target: { kind: 'environment', environmentId: 'env-managed' } },
      true
    ],
    [
      'a workspace on a paired server that is not an SSH host',
      { kind: 'endpoint', target: { kind: 'environment', environmentId: 'env-paired' } },
      false
    ],
    ['a local workspace', { kind: 'endpoint', target: { kind: 'local' } }, false],
    ['an unknown owner', { kind: 'unknown' }, false]
  ])('%s', (_name, host, visible) => {
    expect(portsPanelReachesSshHost(host, environments)).toBe(visible)
  })

  it('follows the workspace owner, not the repo connection', () => {
    const state: WorktreeOperationRouteState = {
      repos: [{ id: 'repo-1' }],
      worktreesByRepo: { 'repo-1': [worktree('runtime:env-managed', 'env-managed')] },
      runtimeEnvironments: [{ id: 'env-managed' }],
      runtimeEnvironmentCatalogHydrated: true
    }
    const host = portsPanelHostForOwnerKey(getPortsPanelOwnerKey(state, WORKTREE_ID))
    expect(portsPanelReachesSshHost(host, environments)).toBe(true)
  })
})

describe('Ports panel forwards', () => {
  const ports = { localPort: 41_000, remotePort: 6768 }
  const environments = [
    { id: 'env-paired' },
    { id: 'env-ssh', orcadDeployment: { sshTargetId: 'box', sshTargetGeneration: 1, ...ports } },
    { id: 'env-wsl', orcadDeployment: { kind: 'wsl' as const, distro: 'Ubuntu', ...ports } }
  ]
  const onServer = (environmentId: string): PortsPanelHost => ({
    kind: 'endpoint',
    target: { kind: 'environment', environmentId }
  })

  // #29153: a moved host's workspace is owned by its server, yet forwards still ride its SSH host.
  it.each<[string, PortsPanelHost, string | null]>([
    ['a workspace on a managed server reached over SSH', onServer('env-ssh'), 'box'],
    ['a workspace on a managed WSL server', onServer('env-wsl'), null],
    ['a workspace on a paired server', onServer('env-paired'), null],
    ['a workspace on an unknown server', onServer('env-gone'), null],
    ['a local workspace', { kind: 'endpoint', target: { kind: 'local' } }, null],
    [
      'a direct SSH workspace, which lists its own forwards',
      { kind: 'direct-ssh', connectionId: 'box' },
      null
    ]
  ])('%s', (_name, host, targetId) => {
    expect(portsPanelForwardTargetId(host, environments)).toBe(targetId)
  })
})
