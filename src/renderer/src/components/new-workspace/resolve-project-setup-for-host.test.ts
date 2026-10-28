import { describe, expect, it } from 'vitest'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import {
  listProjectEligibleHostIds,
  resolveProjectSetupForHost,
  resolveSelectedProjects
} from './resolve-project-setup-for-host'

function setup(id: string, patch: Partial<ProjectHostSetup> = {}): ProjectHostSetup {
  return {
    id,
    projectId: 'p1',
    hostId: 'local',
    repoId: `repo-${id}`,
    path: `/code/${id}`,
    displayName: id,
    kind: 'git',
    setupState: 'ready',
    setupMethod: 'imported-existing-folder',
    createdAt: 100,
    updatedAt: 100,
    ...patch
  }
}

describe('resolveProjectSetupForHost', () => {
  it('reports no setup on the host when the project has none there', () => {
    expect(resolveProjectSetupForHost('p1', 'local', [])).toEqual({
      status: 'unavailable',
      reason: 'no_setup_on_host'
    })
    expect(resolveProjectSetupForHost('p1', 'runtime:a', [setup('s1')])).toEqual({
      status: 'unavailable',
      reason: 'no_setup_on_host'
    })
    expect(resolveProjectSetupForHost('p2', 'local', [setup('s1')])).toMatchObject({
      reason: 'no_setup_on_host'
    })
  })

  it('uses the single eligible setup', () => {
    const only = setup('s1')
    expect(resolveProjectSetupForHost('p1', 'local', [only])).toEqual({
      status: 'resolved',
      setup: only,
      eligible: [only]
    })
  })

  it('defaults to the oldest setup, then the smallest id', () => {
    const newer = setup('a', { createdAt: 200 })
    const older = setup('z', { createdAt: 50 })
    const tieB = setup('b', { createdAt: 50 })
    const result = resolveProjectSetupForHost('p1', 'local', [newer, older, tieB])
    expect(result).toMatchObject({ status: 'resolved', setup: tieB })
    expect(result.status === 'resolved' && result.eligible.map((entry) => entry.id)).toEqual([
      'b',
      'z',
      'a'
    ])
  })

  it('honors an eligible override and ignores a stale one', () => {
    const a = setup('a', { createdAt: 1 })
    const b = setup('b', { createdAt: 2 })
    expect(resolveProjectSetupForHost('p1', 'local', [a, b], 'b')).toMatchObject({ setup: b })
    expect(resolveProjectSetupForHost('p1', 'local', [a, b], 'gone')).toMatchObject({ setup: a })
    const remote = setup('r', { hostId: 'runtime:a' })
    expect(resolveProjectSetupForHost('p1', 'local', [a, remote], 'r')).toMatchObject({ setup: a })
  })

  it('names the cause when no setup is eligible', () => {
    expect(
      resolveProjectSetupForHost('p1', 'local', [setup('s', { connectionId: 'conn' })])
    ).toEqual({ status: 'unavailable', reason: 'direct_ssh' })
    expect(
      resolveProjectSetupForHost('p1', 'ssh:box', [setup('s', { hostId: 'ssh:box' })])
    ).toEqual({ status: 'unavailable', reason: 'direct_ssh' })
    expect(
      resolveProjectSetupForHost('p1', 'local', [
        setup('s', { path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\api' })
      ])
    ).toEqual({ status: 'unavailable', reason: 'wsl' })
    expect(resolveProjectSetupForHost('p1', 'local', [setup('s', { kind: 'folder' })])).toEqual({
      status: 'unavailable',
      reason: 'folder'
    })
    expect(
      resolveProjectSetupForHost('p1', 'local', [setup('s', { setupState: 'error' })])
    ).toEqual({ status: 'unavailable', reason: 'not_ready' })
  })

  it('skips ineligible setups when an eligible one exists on the host', () => {
    const ssh = setup('a', { createdAt: 1, connectionId: 'conn' })
    const ok = setup('b', { createdAt: 2 })
    expect(resolveProjectSetupForHost('p1', 'local', [ssh, ok])).toMatchObject({
      status: 'resolved',
      setup: ok,
      eligible: [ok]
    })
  })
})

describe('host switch with projects already selected', () => {
  const local = setup('l1', { projectId: 'api' })
  const remoteWeb = setup('w1', { projectId: 'web', hostId: 'runtime:a' })
  const localWeb = setup('w2', { projectId: 'web' })
  const setups = [local, remoteWeb, localWeb]

  it('keeps every selected project and flags the ones without a setup', () => {
    const onRemote = resolveSelectedProjects(['api', 'web'], 'runtime:a', setups)
    expect(onRemote.map((entry) => entry.projectId)).toEqual(['api', 'web'])
    expect(onRemote[0].resolution).toEqual({ status: 'unavailable', reason: 'no_setup_on_host' })
    expect(onRemote[1].resolution).toMatchObject({ status: 'resolved', setup: remoteWeb })
  })

  it('does not let selection order change the host decision', () => {
    const forward = resolveSelectedProjects(['api', 'web'], 'local', setups)
    const reversed = resolveSelectedProjects(['web', 'api'], 'local', setups)
    expect(forward.every((entry) => entry.resolution.status === 'resolved')).toBe(true)
    expect(reversed.every((entry) => entry.resolution.status === 'resolved')).toBe(true)
  })

  it('lists the other hosts that would make a project eligible', () => {
    expect(listProjectEligibleHostIds('web', setups).sort()).toEqual(['local', 'runtime:a'])
    expect(listProjectEligibleHostIds('api', setups)).toEqual(['local'])
    expect(
      listProjectEligibleHostIds('api', [setup('x', { projectId: 'api', connectionId: 'c' })])
    ).toEqual([])
  })
})
