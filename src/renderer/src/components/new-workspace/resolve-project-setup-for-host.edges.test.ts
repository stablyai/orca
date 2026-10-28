import { describe, expect, it } from 'vitest'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import {
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

describe('resolveProjectSetupForHost edges', () => {
  it('ignores an override that points at an ineligible setup on the same host', () => {
    const ok = setup('ok', { createdAt: 2 })
    const ssh = setup('ssh', { createdAt: 1, connectionId: 'conn' })
    const wsl = setup('wsl', { createdAt: 3, path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\api' })
    expect(resolveProjectSetupForHost('p1', 'local', [ssh, ok, wsl], 'ssh')).toMatchObject({
      status: 'resolved',
      setup: ok,
      eligible: [ok]
    })
    expect(resolveProjectSetupForHost('p1', 'local', [ssh, ok, wsl], 'wsl')).toMatchObject({
      setup: ok
    })
  })

  it('puts the overridden setup first and keeps the rest in default order', () => {
    const a = setup('a', { createdAt: 1 })
    const b = setup('b', { createdAt: 2 })
    const c = setup('c', { createdAt: 3 })
    const result = resolveProjectSetupForHost('p1', 'local', [c, a, b], 'c')
    expect(result.status === 'resolved' && result.eligible.map((s) => s.id)).toEqual([
      'c',
      'a',
      'b'
    ])
  })

  it('reports the reason of the oldest setup when every setup is ineligible', () => {
    const ssh = setup('a', { createdAt: 1, connectionId: 'conn' })
    const folder = setup('b', { createdAt: 2, kind: 'folder' })
    expect(resolveProjectSetupForHost('p1', 'local', [folder, ssh])).toEqual({
      status: 'unavailable',
      reason: 'direct_ssh'
    })
  })

  it('treats a ssh: host id as direct SSH even without connectionId', () => {
    expect(
      resolveProjectSetupForHost('p1', 'ssh:box', [setup('s', { hostId: 'ssh:box' })])
    ).toMatchObject({ reason: 'direct_ssh' })
  })

  it('does not mutate the input setups array', () => {
    const input = [setup('z', { createdAt: 9 }), setup('a', { createdAt: 1 })]
    const snapshot = [...input]
    resolveProjectSetupForHost('p1', 'local', input)
    expect(input).toEqual(snapshot)
  })

  it('does not treat a non-ready state as eligible', () => {
    const states: ProjectHostSetup['setupState'][] = [
      'error',
      'not-set-up',
      'setting-up',
      'unsupported'
    ]
    for (const state of states) {
      expect(
        resolveProjectSetupForHost('p1', 'local', [setup('s', { setupState: state })])
      ).toEqual({ status: 'unavailable', reason: 'not_ready' })
    }
  })
})

describe('resolveSelectedProjects edges', () => {
  const api = setup('api-l', { projectId: 'api' })
  const apiR = setup('api-r', { projectId: 'api', hostId: 'runtime:a' })
  const web = setup('web-l', { projectId: 'web' })
  const setups = [api, apiR, web]

  it('gives the same per-project result regardless of selection order', () => {
    const forward = resolveSelectedProjects(['api', 'web'], 'runtime:a', setups)
    const reversed = resolveSelectedProjects(['web', 'api'], 'runtime:a', setups)
    const byId = (list: typeof forward) =>
      Object.fromEntries(list.map((entry) => [entry.projectId, entry.resolution]))
    expect(byId(reversed)).toEqual(byId(forward))
    expect(reversed.map((entry) => entry.projectId)).toEqual(['web', 'api'])
  })

  it('drops a stale override after the host changes', () => {
    const apiL2 = setup('api-l2', { projectId: 'api', createdAt: 500 })
    const all = [api, apiL2, apiR]
    const onLocal = resolveSelectedProjects(['api'], 'local', all, { api: 'api-l2' })
    expect(onLocal[0].resolution).toMatchObject({ setup: apiL2 })
    const onRemote = resolveSelectedProjects(['api'], 'runtime:a', all, { api: 'api-l2' })
    expect(onRemote[0].resolution).toMatchObject({ setup: apiR })
  })

  it('keeps a duplicate project id as two entries (caller must dedupe)', () => {
    expect(resolveSelectedProjects(['api', 'api'], 'local', setups)).toHaveLength(2)
  })

  it('returns an empty list for an empty selection', () => {
    expect(resolveSelectedProjects([], 'local', setups)).toEqual([])
  })
})
