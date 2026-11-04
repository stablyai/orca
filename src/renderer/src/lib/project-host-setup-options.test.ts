import { describe, expect, it } from 'vitest'
import { getExecutionHostLabel, type ExecutionHostId } from '../../../shared/execution-host'
import {
  buildExecutionHostRegistry,
  type ExecutionHostRegistryEntry
} from '../../../shared/execution-host-registry'
import type { ProjectHostSetup } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import { buildProjectHostSetupOptions } from './project-host-setup-options'

const LOCAL_HOST_LABEL = getExecutionHostLabel('local')

function repo(id: string): Repo {
  return {
    id,
    path: `/repos/${id}`,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 1
  }
}

function setup(
  id: string,
  projectId: string,
  hostId: ExecutionHostId,
  repoId: string,
  overrides: Partial<ProjectHostSetup> = {}
): ProjectHostSetup {
  return {
    id,
    projectId,
    hostId,
    repoId,
    path: `/repos/${repoId}`,
    displayName: repoId,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function host(
  id: ExecutionHostId,
  overrides: Partial<ExecutionHostRegistryEntry> = {}
): ExecutionHostRegistryEntry {
  return {
    id,
    kind: id === 'local' ? 'local' : id.startsWith('ssh:') ? 'ssh' : 'runtime',
    label: id === 'local' ? LOCAL_HOST_LABEL : id.replace(/^ssh:|^runtime:/, ''),
    detail: id === 'local' ? 'This computer' : 'Host',
    health: id === 'local' ? 'local' : 'available',
    ...overrides
  }
}

describe('buildProjectHostSetupOptions', () => {
  it('collapses duplicate ready setups on one host to the setup creation actually uses', () => {
    // Linked worktrees added as projects can duplicate ready Local Mac rows distinguished only by path.
    const options = buildProjectHostSetupOptions({
      projectId: 'project-1',
      eligibleRepos: [repo('main-checkout'), repo('worktree-a'), repo('worktree-b')],
      hosts: [host('local')],
      projectHostSetups: [
        setup('main', 'project-1', 'local', 'main-checkout', { path: '/Users/dev/projects/orca' }),
        setup('dup-a', 'project-1', 'local', 'worktree-a', {
          path: '/Users/dev/worktrees/pr-1908'
        }),
        setup('dup-b', 'project-1', 'local', 'worktree-b', { path: '/Users/dev/worktrees/pr-3235' })
      ]
    })

    expect(options).toEqual([
      expect.objectContaining({ id: 'main', kind: 'ready', label: LOCAL_HOST_LABEL })
    ])
  })

  function managedOpenclawHosts(): ExecutionHostRegistryEntry[] {
    return buildExecutionHostRegistry({
      repos: [],
      settings: null,
      hostSource: 'configured-only',
      sshTargetLabels: new Map([['openclaw-target', 'openclaw']]),
      runtimeEnvironments: [
        {
          id: 'openclaw-server',
          name: 'openclaw',
          orcadDeployment: { sshTargetId: 'openclaw-target' }
        }
      ]
    })
  }

  it('shows one row when an SSH host and its managed server report the same checkout', () => {
    const checkout = { path: '/home/neil/projects/orca' }
    const options = buildProjectHostSetupOptions({
      projectId: 'project-1',
      eligibleRepos: [repo('local-repo'), repo('ssh-repo'), repo('server-repo')],
      hosts: [host('local'), ...managedOpenclawHosts()],
      projectHostSetups: [
        setup('local', 'project-1', 'local', 'local-repo'),
        // The SSH repo predates the managed server, so it comes first in store order.
        setup('ssh', 'project-1', 'ssh:openclaw-target', 'ssh-repo', checkout),
        setup('server', 'project-1', 'runtime:openclaw-server', 'server-repo', checkout)
      ]
    })

    expect(options.filter((option) => option.label === 'openclaw')).toEqual([
      expect.objectContaining({
        kind: 'ready',
        id: 'server',
        hostId: 'runtime:openclaw-server',
        aliasSetups: [{ id: 'ssh', hostId: 'ssh:openclaw-target' }]
      })
    ])
  })

  it('keeps distinct checkouts on an SSH host and its managed server as separate rows', () => {
    const options = buildProjectHostSetupOptions({
      projectId: 'project-1',
      eligibleRepos: [repo('ssh-repo'), repo('server-repo')],
      hosts: managedOpenclawHosts(),
      projectHostSetups: [
        setup('ssh', 'project-1', 'ssh:openclaw-target', 'ssh-repo', { path: '/home/neil/a' }),
        setup('server', 'project-1', 'runtime:openclaw-server', 'server-repo', {
          path: '/home/neil/b'
        })
      ]
    })

    expect(
      options
        .filter((option) => option.kind === 'ready')
        .map((option) => [option.id, option.hostId])
    ).toEqual([
      ['ssh', 'ssh:openclaw-target'],
      ['server', 'runtime:openclaw-server']
    ])
  })
})
