import { describe, expect, it } from 'vitest'
import { buildExecutionHostRegistry } from '../../../shared/execution-host-registry'
import type { Repo } from '../../../shared/repo-types'
import type { SshConnectionState } from '../../../shared/ssh-types'
import { buildProjectHostSetupOptions } from './project-host-setup-options'
import { resolveWorkspaceCreationTarget } from './project-host-workspace-target'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'

const SSH_REPO: Repo = {
  id: 'r-ssh',
  path: '/srv/app',
  displayName: 'app',
  badgeColor: '#000000',
  addedAt: 1,
  connectionId: 'tgt'
}
const SERVER_REPO: Repo = {
  id: 'r-server',
  path: '/srv/api',
  displayName: 'api',
  badgeColor: '#000000',
  addedAt: 1,
  executionHostId: 'runtime:env1'
}
const LOCAL_REPO: Repo = {
  id: 'r-local',
  path: '/repos/local',
  displayName: 'local',
  badgeColor: '#000000',
  addedAt: 1
}

function composerHosts(sshState?: Pick<SshConnectionState, 'status' | 'managedServer'>) {
  return buildExecutionHostRegistry({
    repos: [SSH_REPO, SERVER_REPO, LOCAL_REPO],
    settings: null,
    hostSource: 'configured-only',
    sshTargetLabels: new Map([['tgt', 'Omarchy']]),
    sshConnectionStates: sshState
      ? new Map([['tgt', { targetId: 'tgt', error: null, reconnectAttempt: 0, ...sshState }]])
      : undefined,
    runtimeEnvironments: [{ id: 'env1', name: 'Omarchy', orcadDeployment: { sshTargetId: 'tgt' } }]
  })
}

function resolve(draftRepoId: string, hosts: ReturnType<typeof composerHosts>) {
  return resolveWorkspaceCreationTarget({
    eligibleRepos: [SSH_REPO, SERVER_REPO, LOCAL_REPO],
    draftRepoId,
    actionableHostIds: new Set(hosts.map((host) => host.id))
  })
}

describe('workspace targets on an SSH host merged with its managed server', () => {
  it.each([
    ['at app start', undefined],
    ['while connecting', { status: 'connecting' } as const],
    [
      'while setting up',
      { status: 'connecting', managedServer: { kind: 'setting-up', phase: 'deploying' } } as const
    ],
    [
      'once managed',
      { status: 'connected', managedServer: { kind: 'managed', environmentId: 'env1' } } as const
    ]
  ])('keeps a draft on the SSH repo %s', (_phase, sshState) => {
    const resolution = resolve('r-ssh', composerHosts(sshState))

    expect(resolution).toMatchObject({
      status: 'ready',
      target: { repoId: 'r-ssh', hostId: 'ssh:tgt' }
    })
  })

  it('keeps a draft on the server repo while the host is on its relay', () => {
    const resolution = resolve(
      'r-server',
      composerHosts({
        status: 'connected',
        managedServer: { kind: 'relay', reason: 'source_changed' }
      })
    )

    expect(resolution).toMatchObject({
      status: 'ready',
      target: { repoId: 'r-server', hostId: 'runtime:env1' }
    })
  })

  it('still offers a ready server project while the host is on its relay', () => {
    const projection = projectHostSetupProjectionFromRepos([SERVER_REPO])
    const options = buildProjectHostSetupOptions({
      projectId: projection.setups[0]!.projectId,
      projectHostSetups: projection.setups,
      eligibleRepos: [SERVER_REPO],
      hosts: composerHosts({
        status: 'connected',
        managedServer: { kind: 'relay', reason: 'source_changed' }
      })
    })

    expect(options.filter((option) => option.label === 'Omarchy')).toEqual([
      expect.objectContaining({ kind: 'ready', hostId: 'runtime:env1' })
    ])
  })

  it('never swaps an unactionable draft repo for an unrelated local project', () => {
    const resolution = resolveWorkspaceCreationTarget({
      eligibleRepos: [SSH_REPO, LOCAL_REPO],
      draftRepoId: 'r-ssh',
      actionableHostIds: new Set(['local'])
    })

    expect(resolution).toEqual({ status: 'unavailable', reason: 'setup-not-found' })
  })
})
