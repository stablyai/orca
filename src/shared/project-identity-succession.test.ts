import { describe, expect, it } from 'vitest'
import { carryProjectStateThroughIdentityChange } from './project-identity-succession'
import type { Project } from './types'

const makeProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  displayName: 'Project',
  badgeColor: '#737373',
  sourceRepoIds: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

describe('carryProjectStateThroughIdentityChange', () => {
  it('keeps the exact-id match and reports no remap', () => {
    const projected = makeProject({ id: 'git:host/acme/app', sourceRepoIds: ['r1'] })
    const previous = makeProject({
      id: 'git:host/acme/app',
      sourceRepoIds: ['r1'],
      updatedAt: 50,
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })

    const result = carryProjectStateThroughIdentityChange([projected], [previous])

    expect(result.projects[0]).toMatchObject({
      id: 'git:host/acme/app',
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
      updatedAt: 50
    })
    expect(result.remappedProjectIds.size).toBe(0)
  })

  it('adopts a prior row through a changed identity key by repo overlap', () => {
    const projected = makeProject({ id: 'github:acme/app', sourceRepoIds: ['r1'] })
    const previous = makeProject({
      id: 'repo:r1',
      sourceRepoIds: ['r1'],
      localWindowsRuntimePreference: { kind: 'windows-host' }
    })

    const result = carryProjectStateThroughIdentityChange([projected], [previous])

    expect(result.projects[0]?.localWindowsRuntimePreference).toEqual({ kind: 'windows-host' })
    expect([...result.remappedProjectIds]).toEqual([['repo:r1', 'github:acme/app']])
  })

  it('ignores prior rows that still exist under their own id', () => {
    const kept = makeProject({ id: 'git:host/acme/app', sourceRepoIds: ['r1'] })
    const renamed = makeProject({ id: 'git:host/acme/tool', sourceRepoIds: ['r2'] })
    const previousKept = makeProject({
      id: 'git:host/acme/app',
      sourceRepoIds: ['r1', 'r2'],
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })

    const result = carryProjectStateThroughIdentityChange([kept, renamed], [previousKept])

    expect(result.projects[1]?.localWindowsRuntimePreference).toBeUndefined()
    expect(result.remappedProjectIds.size).toBe(0)
  })

  it('prefers the prior row sharing the most repos over the more recently updated one', () => {
    const projected = makeProject({ id: 'git:host/acme/merged', sourceRepoIds: ['r1', 'r2'] })
    const wide = makeProject({
      id: 'git:host/acme/wide',
      sourceRepoIds: ['r1', 'r2'],
      updatedAt: 10,
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })
    const narrow = makeProject({
      id: 'git:host/acme/narrow',
      sourceRepoIds: ['r2'],
      updatedAt: 900,
      localWindowsRuntimePreference: { kind: 'windows-host' }
    })

    const result = carryProjectStateThroughIdentityChange([projected], [wide, narrow])

    expect(result.projects[0]?.localWindowsRuntimePreference).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu'
    })
    expect([...result.remappedProjectIds.keys()]).toEqual(['git:host/acme/wide'])
  })

  it('breaks an equal-overlap tie by newest updatedAt, then lowest prior id', () => {
    const projected = makeProject({ id: 'git:host/acme/merged', sourceRepoIds: ['r1', 'r2'] })
    const older = makeProject({
      id: 'git:host/acme/a',
      sourceRepoIds: ['r1'],
      updatedAt: 100,
      localWindowsRuntimePreference: { kind: 'windows-host' }
    })
    const newer = makeProject({
      id: 'git:host/acme/b',
      sourceRepoIds: ['r2'],
      updatedAt: 200,
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })

    expect(
      carryProjectStateThroughIdentityChange([projected], [older, newer]).projects[0]
        ?.localWindowsRuntimePreference
    ).toEqual({ kind: 'wsl', distro: 'Ubuntu' })

    const sameStamp = { ...newer, updatedAt: 100 }
    // Same overlap and same updatedAt: the lexicographically lowest prior id wins, both orders.
    for (const previous of [
      [older, sameStamp],
      [sameStamp, older]
    ]) {
      const result = carryProjectStateThroughIdentityChange([projected], previous)
      expect(result.projects[0]?.localWindowsRuntimePreference).toEqual({ kind: 'windows-host' })
      expect([...result.remappedProjectIds.keys()]).toEqual(['git:host/acme/a'])
    }
  })

  it('lets one prior row be claimed by only one surviving project', () => {
    const left = makeProject({ id: 'git:host/acme/left', sourceRepoIds: ['r1'] })
    const right = makeProject({ id: 'git:host/acme/right', sourceRepoIds: ['r2'] })
    const previous = makeProject({
      id: 'repo:r1',
      sourceRepoIds: ['r1', 'r2'],
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })

    const result = carryProjectStateThroughIdentityChange([left, right], [previous])

    expect(result.projects[0]?.localWindowsRuntimePreference).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu'
    })
    expect(result.projects[1]?.localWindowsRuntimePreference).toBeUndefined()
    expect([...result.remappedProjectIds]).toEqual([['repo:r1', 'git:host/acme/left']])
  })
})
