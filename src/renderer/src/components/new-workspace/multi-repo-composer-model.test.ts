import { describe, expect, it } from 'vitest'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import {
  buildMultiRepoCreateMembers,
  countBranchOverrides,
  isMultiRepoSelectionFull,
  recordCreateInLastSet,
  resolveSameAsLastTime,
  toggleMultiRepoSelection
} from './multi-repo-composer-model'

function setup(projectId: string, patch: Partial<ProjectHostSetup> = {}): ProjectHostSetup {
  return {
    id: `s-${projectId}`,
    projectId,
    hostId: 'local',
    repoId: `repo-${projectId}`,
    path: `/code/${projectId}`,
    displayName: projectId,
    kind: 'git',
    setupState: 'ready',
    setupMethod: 'imported-existing-folder',
    createdAt: 1,
    updatedAt: 1,
    ...patch
  }
}

describe('selection', () => {
  it('toggles in order and caps at the member limit', () => {
    expect(toggleMultiRepoSelection(['a', 'b'], 'c')).toEqual(['a', 'b', 'c'])
    expect(toggleMultiRepoSelection(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
    expect(isMultiRepoSelectionFull(Array.from({ length: 12 }, (_, i) => `p${i}`))).toBe(true)
    expect(isMultiRepoSelectionFull(['a'])).toBe(false)
  })
})

describe('buildMultiRepoCreateMembers', () => {
  const setups = [setup('api'), setup('web'), setup('infra')]

  it('sends repo ids of the resolved setups in selection order, never project ids', () => {
    expect(buildMultiRepoCreateMembers(['web', 'api'], 'local', setups, {}, {})).toEqual({
      ok: true,
      members: [{ repoId: 'repo-web' }, { repoId: 'repo-api' }]
    })
  })

  it('uses the chip override for the setup and drops blank branch overrides', () => {
    const second = setup('api', { id: 'api-2', repoId: 'repo-api-2', createdAt: 9 })
    expect(
      buildMultiRepoCreateMembers(
        ['api', 'web'],
        'local',
        [...setups, second],
        { api: 'api-2' },
        { api: { branchName: '  ', baseRef: 'origin/dev' }, web: { branchName: 'hotfix' } }
      )
    ).toEqual({
      ok: true,
      members: [
        { repoId: 'repo-api-2', baseRef: 'origin/dev' },
        { repoId: 'repo-web', branchName: 'hotfix' }
      ]
    })
  })

  it('refuses to send when a project has no setup on the workspace host', () => {
    expect(buildMultiRepoCreateMembers(['api', 'web'], 'runtime:a', setups, {}, {})).toEqual({
      ok: false,
      projectId: 'api',
      reason: 'no_setup_on_host'
    })
  })

  it('names direct SSH and WSL setups as the cause', () => {
    expect(
      buildMultiRepoCreateMembers(
        ['api'],
        'local',
        [setup('api', { connectionId: 'conn' })],
        {},
        {}
      )
    ).toMatchObject({ ok: false, reason: 'direct_ssh' })
  })
})

describe('countBranchOverrides', () => {
  it('counts only branches that differ from the shared name', () => {
    expect(
      countBranchOverrides(
        ['a', 'b'],
        { a: { branchName: 'flow' }, b: { branchName: 'x' } },
        'flow'
      )
    ).toBe(1)
  })
})

describe('last set memory', () => {
  it('remembers a multi-repo create and clears after two single creates', () => {
    const first = recordCreateInLastSet(null, ['a', 'b'])
    expect(first).toEqual({ projectIds: ['a', 'b'], singleCreatesSince: 0 })
    const one = recordCreateInLastSet(first, ['a'])
    expect(one).toEqual({ projectIds: ['a', 'b'], singleCreatesSince: 1 })
    expect(recordCreateInLastSet(one, ['c'])).toBeNull()
    expect(recordCreateInLastSet(null, ['a'])).toBeNull()
  })

  it('offers the link for one selected project while the whole set resolves on the host', () => {
    const last = { projectIds: ['api', 'web'], singleCreatesSince: 0 }
    const setups = [setup('api'), setup('web')]
    expect(resolveSameAsLastTime(last, ['api'], 'local', setups)).toEqual(['api', 'web'])
    expect(resolveSameAsLastTime(last, ['api', 'web'], 'local', setups)).toBeNull()
    expect(resolveSameAsLastTime(last, [], 'local', setups)).toBeNull()
    expect(resolveSameAsLastTime(last, ['api'], 'runtime:a', setups)).toBeNull()
    expect(resolveSameAsLastTime(last, ['api'], 'local', [setup('api')])).toBeNull()
  })
})
