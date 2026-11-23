import { describe, expect, it } from 'vitest'
import type { ExecutionHostRegistryEntry } from '../../../../shared/execution-host/execution-host-registry-entry'
import type { ProjectHostSetup } from '../../../../shared/project/project-types'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import {
  listOpenOnHostTargets,
  type OpenOnHostTarget,
  type OpenOnHostTargetsInput
} from './open-on-host-targets'

// The real translator: en.json holds the same text as each call's fallback.
const t: Translate = translate

function runtimeHost(id: `runtime:${string}`, capabilities: string[]): ExecutionHostRegistryEntry {
  return {
    id,
    kind: 'runtime',
    label: id.slice('runtime:'.length),
    detail: '',
    health: 'available',
    capabilities
  }
}

const baseCapabilities = ['project-host-setup.v1', 'workspace-run-context.v1']

const setup: ProjectHostSetup = {
  id: 'setup-buildbox',
  projectId: 'project-1',
  hostId: 'runtime:buildbox',
  repoId: 'repo-1',
  path: '/home/me/orca',
  displayName: 'orca',
  setupState: 'ready',
  setupMethod: 'cloned',
  createdAt: 1,
  updatedAt: 1
}

const input: OpenOnHostTargetsInput = {
  projectId: 'project-1',
  sourceHostId: 'local',
  projectHostSetups: [setup],
  eligibleRepos: [
    { id: 'repo-1', path: '/Users/me/orca', displayName: 'orca', badgeColor: '', addedAt: 0 }
  ],
  hosts: [
    runtimeHost('runtime:buildbox', [
      ...baseCapabilities,
      'worktree.open-existing-branch.v2-request.v1'
    ]),
    runtimeHost('runtime:old', baseCapabilities),
    { id: 'ssh:box', kind: 'ssh', label: 'box', detail: '', health: 'available' },
    { id: 'local', kind: 'local', label: 'This Mac', detail: '', health: 'local' }
  ],
  cloneUrl: 'https://github.com/o/orca.git',
  requireBranchReuse: false
}

function byHost(
  hostId: string,
  targets: OpenOnHostTarget[] = listOpenOnHostTargets(input, t)
): OpenOnHostTarget {
  const target = targets.find((candidate) => candidate.hostId === hostId)
  if (!target) {
    throw new Error(`no target for ${hostId}`)
  }
  return target
}

describe('listOpenOnHostTargets', () => {
  it('lists runtime hosts only, without the source host', () => {
    expect(listOpenOnHostTargets(input, t).map((target) => target.hostId)).toEqual([
      'runtime:buildbox',
      'runtime:old'
    ])
    const fromBuildbox = listOpenOnHostTargets({ ...input, sourceHostId: 'runtime:buildbox' }, t)
    expect(fromBuildbox.map((target) => target.hostId)).toEqual(['runtime:old'])
  })

  it('carries the existing location on a host that has one', () => {
    expect(byHost('runtime:buildbox').existingSetup?.path).toBe('/home/me/orca')
    expect(byHost('runtime:old').existingSetup).toBeNull()
    expect(byHost('runtime:buildbox').disabledReason).toBeNull()
    expect(byHost('runtime:old').disabledReason).toBeNull()
  })

  it('disables a workspace item on a host without branch reuse', () => {
    const targets = listOpenOnHostTargets({ ...input, requireBranchReuse: true }, t)
    expect(byHost('runtime:old', targets).disabledReason).not.toBeNull()
    expect(byHost('runtime:buildbox', targets).disabledReason).toBeNull()
  })

  it('disables cloning hosts when the project has no remote', () => {
    const targets = listOpenOnHostTargets({ ...input, cloneUrl: '' }, t)
    expect(byHost('runtime:old', targets).disabledReason).not.toBeNull()
    expect(byHost('runtime:buildbox', targets).disabledReason).not.toBeNull()
  })

  it('disables a host that cannot take a new location', () => {
    const targets = listOpenOnHostTargets(
      {
        ...input,
        hosts: [
          ...input.hosts,
          { ...runtimeHost('runtime:asleep', baseCapabilities), health: 'disconnected' }
        ]
      },
      t
    )
    expect(byHost('runtime:asleep', targets).disabledReason).not.toBeNull()
  })

  it('skips a host that is an alias of the source host', () => {
    const targets = listOpenOnHostTargets(
      {
        ...input,
        sourceHostId: 'ssh:box',
        hosts: [
          ...input.hosts.filter((host) => host.id !== 'ssh:box'),
          {
            id: 'ssh:box',
            kind: 'ssh',
            label: 'box',
            detail: '',
            health: 'available',
            mergedIntoHostId: 'runtime:box'
          },
          { ...runtimeHost('runtime:box', baseCapabilities), aliasHostIds: ['ssh:box'] }
        ]
      },
      t
    )
    expect(targets.map((target) => target.hostId)).toEqual(['runtime:buildbox', 'runtime:old'])
  })

  it('targets the server of an SSH host served over the relay, not a plain SSH host', () => {
    const targets = listOpenOnHostTargets(
      {
        ...input,
        hosts: [
          {
            id: 'ssh:devbox',
            kind: 'ssh',
            label: 'devbox',
            detail: '',
            health: 'available',
            aliasHostIds: ['runtime:devbox']
          },
          { ...runtimeHost('runtime:devbox', baseCapabilities), mergedIntoHostId: 'ssh:devbox' },
          { id: 'ssh:plain', kind: 'ssh', label: 'plain', detail: '', health: 'available' }
        ]
      },
      t
    )
    expect(targets.map((target) => [target.hostId, target.environmentId])).toEqual([
      ['runtime:devbox', 'devbox']
    ])
  })

  it('disables a relay-served server that cannot set up projects', () => {
    const targets = listOpenOnHostTargets(
      {
        ...input,
        hosts: [
          {
            id: 'ssh:x',
            kind: 'ssh',
            label: 'x',
            detail: '',
            health: 'available',
            aliasHostIds: ['runtime:x']
          },
          { ...runtimeHost('runtime:x', ['workspace-run-context.v1']), mergedIntoHostId: 'ssh:x' }
        ]
      },
      t
    )
    expect(byHost('runtime:x', targets).disabledReason).not.toBeNull()
  })

  it('disables a ready location on a disconnected host', () => {
    const targets = listOpenOnHostTargets(
      {
        ...input,
        hosts: input.hosts.map((host) =>
          host.id === 'runtime:buildbox' ? { ...host, health: 'disconnected' } : host
        )
      },
      t
    )
    expect(byHost('runtime:buildbox', targets).existingSetup).not.toBeNull()
    expect(byHost('runtime:buildbox', targets).disabledReason).not.toBeNull()
  })

  it('skips a ready location on the merged-away id of the source host', () => {
    const targets = listOpenOnHostTargets(
      {
        ...input,
        sourceHostId: 'ssh:devbox',
        projectHostSetups: [{ ...setup, id: 'setup-devbox', hostId: 'runtime:devbox' }],
        hosts: [
          {
            id: 'ssh:devbox',
            kind: 'ssh',
            label: 'devbox',
            detail: '',
            health: 'available',
            aliasHostIds: ['runtime:devbox']
          },
          { ...runtimeHost('runtime:devbox', baseCapabilities), mergedIntoHostId: 'ssh:devbox' }
        ]
      },
      t
    )
    expect(targets).toEqual([])
  })
})
