import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  isRemoteResourceManagerHost,
  listResourceManagerHosts,
  resolveDefaultResourceManagerHostId,
  resolveDefaultResourceManagerHostIdFromState,
  resolveSelectedResourceManagerHostId
} from './resource-manager-hosts'

function environment(
  id: string,
  overrides: Partial<PublicKnownRuntimeEnvironment> = {}
): PublicKnownRuntimeEnvironment {
  return { id, name: id, ...overrides } as PublicKnownRuntimeEnvironment
}

const connected = { status: {} as RuntimeStatus }

function hostInputs(
  environments: PublicKnownRuntimeEnvironment[],
  statuses: [string, { status?: RuntimeStatus | null } | undefined][] = [],
  overrides: [string, string][] = []
) {
  return {
    runtimeEnvironments: environments,
    runtimeStatusByEnvironmentId: new Map(statuses),
    hostLabelOverrides: new Map(overrides)
  }
}

describe('listResourceManagerHosts', () => {
  it('always offers the local host first', () => {
    const hosts = listResourceManagerHosts(hostInputs([]))
    expect(hosts).toHaveLength(1)
    expect(hosts[0]).toMatchObject({ id: 'local', kind: 'local' })
  })

  it('adds connected user-managed runtime hosts', () => {
    const hosts = listResourceManagerHosts(
      hostInputs([environment('env-1', { name: 'Hetzner VPS' })], [['env-1', connected]])
    )
    expect(hosts.map((host) => host.id)).toEqual(['local', 'runtime:env-1'])
    expect(hosts[1]).toMatchObject({ label: 'Hetzner VPS', kind: 'runtime' })
  })

  // Why: a disconnected host has no snapshot to serve, so offering it would only
  // produce an unreachable panel the user cannot act on from here.
  it('omits hosts that are not connected', () => {
    const hosts = listResourceManagerHosts(
      hostInputs([environment('env-1')], [['env-1', { status: null }]])
    )
    expect(hosts.map((host) => host.id)).toEqual(['local'])
  })

  it('omits hosts with no status entry yet', () => {
    const hosts = listResourceManagerHosts(hostInputs([environment('env-1')]))
    expect(hosts.map((host) => host.id)).toEqual(['local'])
  })

  it('omits ephemeral-VM environments', () => {
    const hosts = listResourceManagerHosts(
      hostInputs([environment('env-1', { source: 'ephemeral-vm' })], [['env-1', connected]])
    )
    expect(hosts.map((host) => host.id)).toEqual(['local'])
  })

  // Why: dropping the host already on screen would silently swap the panel to
  // local numbers under no label at all.
  it('keeps a disconnected host listed while it is the selected one', () => {
    const inputs = {
      ...hostInputs([environment('env-1', { name: 'Hetzner VPS' })], [['env-1', { status: null }]]),
      selectedHostId: 'runtime:env-1'
    }
    expect(listResourceManagerHosts(inputs).map((host) => host.id)).toEqual([
      'local',
      'runtime:env-1'
    ])
  })

  it('still omits other disconnected hosts', () => {
    const inputs = {
      ...hostInputs(
        [environment('env-1'), environment('env-2')],
        [
          ['env-1', { status: null }],
          ['env-2', { status: null }]
        ]
      ),
      selectedHostId: 'runtime:env-1'
    }
    expect(listResourceManagerHosts(inputs).map((host) => host.id)).toEqual([
      'local',
      'runtime:env-1'
    ])
  })

  it('prefers a user host-label override', () => {
    const hosts = listResourceManagerHosts(
      hostInputs(
        [environment('env-1', { name: 'Hetzner VPS' })],
        [['env-1', connected]],
        [['runtime:env-1', 'Build box']]
      )
    )
    expect(hosts[1].label).toBe('Build box')
  })
})

describe('resolveDefaultResourceManagerHostId', () => {
  const hosts = [
    { id: 'local', label: 'Local', kind: 'local' as const },
    { id: 'runtime:env-1', label: 'Hetzner', kind: 'runtime' as const }
  ]
  const worktree = { id: 'wt-1', repoId: 'repo-1', hostId: 'runtime:env-1' } as unknown as Worktree
  const worktreeById = new Map([[worktree.id, worktree]])
  const repoById = new Map<string, Repo>()

  it('opens on the host running the focused workspace', () => {
    expect(
      resolveDefaultResourceManagerHostId({
        hosts,
        activeWorktreeId: 'wt-1',
        worktreeById,
        repoById
      })
    ).toBe('runtime:env-1')
  })

  it('falls back to local with no focused workspace', () => {
    expect(
      resolveDefaultResourceManagerHostId({
        hosts,
        activeWorktreeId: null,
        worktreeById,
        repoById
      })
    ).toBe('local')
  })

  it('falls back to local when that host is not connected', () => {
    expect(
      resolveDefaultResourceManagerHostId({
        hosts: [hosts[0]],
        activeWorktreeId: 'wt-1',
        worktreeById,
        repoById
      })
    ).toBe('local')
  })

  // Why: SSH-hosted workspaces have no selectable host of their own; local is the
  // only view we can honestly render for them.
  it('falls back to local for an SSH-hosted workspace', () => {
    const sshWorktree = { id: 'wt-2', repoId: 'repo-2', hostId: 'ssh:box' } as unknown as Worktree
    expect(
      resolveDefaultResourceManagerHostId({
        hosts,
        activeWorktreeId: 'wt-2',
        worktreeById: new Map([[sshWorktree.id, sshWorktree]]),
        repoById
      })
    ).toBe('local')
  })

  it('derives the host from the repo when the workspace has none', () => {
    const bareWorktree = { id: 'wt-3', repoId: 'repo-3' } as unknown as Worktree
    const repo = { id: 'repo-3', executionHostId: 'runtime:env-1' } as unknown as Repo
    expect(
      resolveDefaultResourceManagerHostId({
        hosts,
        activeWorktreeId: 'wt-3',
        worktreeById: new Map([[bareWorktree.id, bareWorktree]]),
        repoById: new Map([[repo.id, repo]])
      })
    ).toBe('runtime:env-1')
  })
})

describe('resolveSelectedResourceManagerHostId', () => {
  const hosts = [{ id: 'local', label: 'Local', kind: 'local' as const }]

  it('keeps a selection that still resolves', () => {
    expect(resolveSelectedResourceManagerHostId(hosts, 'local')).toBe('local')
  })

  // Why: a host can disconnect while the popover is open.
  it('falls back to local when the selected host disappears', () => {
    expect(resolveSelectedResourceManagerHostId(hosts, 'runtime:env-gone')).toBe('local')
  })
})

describe('isRemoteResourceManagerHost', () => {
  it('separates runtime hosts from local', () => {
    expect(isRemoteResourceManagerHost('runtime:env-1')).toBe(true)
    expect(isRemoteResourceManagerHost('local')).toBe(false)
    expect(isRemoteResourceManagerHost('ssh:box')).toBe(false)
  })
})

describe('resolveDefaultResourceManagerHostIdFromState', () => {
  const hosts = [
    { id: 'local', label: 'Local', kind: 'local' as const },
    { id: 'runtime:env-1', label: 'Hetzner', kind: 'runtime' as const }
  ]
  const worktree = { id: 'wt-1', repoId: 'repo-1', hostId: 'runtime:env-1' } as unknown as Worktree

  // Why: the panel's own slices are empty while it is closed, and the default is
  // decided on the open edge — reading them there resolved everything to local.
  it('resolves the focused workspace host from canonical state', () => {
    expect(
      resolveDefaultResourceManagerHostIdFromState(
        {
          activeWorktreeId: 'wt-1',
          repos: [],
          worktreesByRepo: { 'repo-1': [worktree] }
        },
        hosts
      )
    ).toBe('runtime:env-1')
  })

  it('falls back to local when nothing is focused', () => {
    expect(
      resolveDefaultResourceManagerHostIdFromState(
        { activeWorktreeId: null, repos: [], worktreesByRepo: { 'repo-1': [worktree] } },
        hosts
      )
    ).toBe('local')
  })

  it('falls back to local when the workspace is not in state', () => {
    expect(
      resolveDefaultResourceManagerHostIdFromState(
        { activeWorktreeId: 'wt-1', repos: [], worktreesByRepo: {} },
        hosts
      )
    ).toBe('local')
  })
})
