import { withLegacyProjectGroupKeys } from './project-section-legacy-grouping'
import { buildProjectGroupingIndex, getProjectGroupingForRepo } from './project-section-grouping'
import { describe, expect, it } from 'vitest'
import {
  buildProjectGroups,
  getPhysicalProjectKey,
  getProjectGroupKey,
  projectRepoFilterMatcher,
  selectProjectGroupTarget
} from './project-grouping'
import type { ProjectHostSetup } from './project-types'
import { carryProjectGroupingOverrides } from './project-identity-succession'
import { applyManualRepoOrder } from './manual-repo-order'

const setup = (
  repoId: string,
  hostId: ProjectHostSetup['hostId'] = 'local',
  path = `/src/${repoId}`
): ProjectHostSetup => ({
  id: repoId,
  repoId,
  projectId: 'github:org/app',
  hostId,
  path,
  displayName: repoId,
  setupState: 'ready',
  setupMethod: 'cloned',
  createdAt: 0,
  updatedAt: 0
})

const first = setup('first')
const second = setup('second')
const remote = setup('first', 'runtime:server')
const model = {
  projects: [{ id: first.projectId, displayName: 'app' }],
  projectHostSetups: [first, second, remote]
}

describe('project grouping', () => {
  it('reuses unchanged grouping inputs and invalidates mode and override changes', () => {
    const initial = buildProjectGroups(model, { projectGroupingMode: 'repository' })
    expect(buildProjectGroups(model, { projectGroupingMode: 'repository' })).toBe(initial)
    const split = buildProjectGroups(model, { projectGroupingMode: 'folder' })
    expect(split).toHaveLength(3)
    const merged = buildProjectGroups(model, {
      projectGroupingMode: 'folder',
      projectGroupingOverrides: { [first.projectId]: 'repository' }
    })
    expect(merged).toHaveLength(1)
    expect(merged).not.toBe(split)
  })

  it('switches one model between repository, host and folder without changing manual order', () => {
    const manualRepoOrder = [
      { hostId: 'local' as const, repoId: 'second' },
      { hostId: 'local' as const, repoId: 'first' }
    ]
    const repos = [first, second].map((entry) => ({
      id: entry.repoId,
      path: entry.path,
      displayName: entry.displayName,
      badgeColor: '',
      addedAt: 0
    }))
    for (const [mode, count] of [
      ['repository', 1],
      ['host', 2],
      ['folder', 3]
    ] as const) {
      expect(buildProjectGroups(model, { projectGroupingMode: mode })).toHaveLength(count)
      expect(applyManualRepoOrder(repos, manualRepoOrder).map((repo) => repo.id)).toEqual([
        'second',
        'first'
      ])
    }
    expect(
      buildProjectGroups(model, {
        projectGroupingMode: 'folder',
        projectGroupingOverrides: { [first.projectId]: 'repository' }
      })
    ).toHaveLength(1)
    expect(getPhysicalProjectKey(first)).not.toBe(getPhysicalProjectKey(remote))
    for (const mode of ['repository', 'host', 'folder'] as const) {
      expect(getProjectGroupKey({ ...first, projectId: 'repo:first' }, mode)).toBe(
        'project:repo:first'
      )
    }
  })

  it('keeps explicit and contextual checkout selections before a host default', () => {
    const group = buildProjectGroups(model)[0]
    expect(selectProjectGroupTarget(group, { setupId: second.id }).repoId).toBe('second')
    expect(selectProjectGroupTarget(group, { path: second.path }).repoId).toBe('second')
    expect(selectProjectGroupTarget(group, { setupId: second.id, hostId: remote.hostId })).toBe(
      second
    )
    expect(selectProjectGroupTarget(group, { contextualRepoId: second.repoId }).repoId).toBe(
      'second'
    )
    expect(selectProjectGroupTarget(group, { hostId: remote.hostId })).toBe(remote)
    expect(
      selectProjectGroupTarget(group, { contextualRepoId: first.repoId, hostId: remote.hostId })
    ).toBe(remote)
  })

  it('deduplicates equivalent registrations and keeps host and filesystem namespaces distinct', () => {
    const twin = { ...first, id: 'twin', repoId: 'twin' }
    expect(
      buildProjectGroups(
        { ...model, projectHostSetups: [first, twin] },
        { projectGroupingMode: 'folder' }
      )[0].members
    ).toHaveLength(1)
    const windows = { ...first, path: 'C:\\src\\app' }
    const wsl = { ...first, path: '\\\\wsl.localhost\\Ubuntu\\src\\app' }
    expect(getProjectGroupKey(windows, 'host')).not.toBe(getProjectGroupKey(wsl, 'host'))
    expect(getProjectGroupKey(first, 'folder')).not.toBe(getProjectGroupKey(remote, 'folder'))
    expect(getProjectGroupKey({ ...first, setupMethod: 'provisioned' }, 'folder')).toBe(
      getProjectGroupKey(first, 'host')
    )
    expect(getProjectGroupKey({ ...first, kind: 'folder' }, 'folder')).toBe(
      getProjectGroupKey(first, 'host')
    )
  })

  it('uses a desktop key when present and the older desktop rule when absent', () => {
    const legacy = withLegacyProjectGroupKeys([first, second, remote])
    expect(legacy[0].groupKey).toBe(`project:${first.projectId}::setup:${first.repoId}`)
    expect(legacy[2].groupKey).toBe(`project:${first.projectId}`)
    const served = withLegacyProjectGroupKeys(
      [first, second].map((entry) => ({ ...entry, groupKey: `project:${first.projectId}` }))
    )
    const index = buildProjectGroupingIndex({ projects: model.projects, projectHostSetups: served })
    expect(
      getProjectGroupingForRepo(second.repoId, new Map([[second.repoId, second]]), index).key
    ).toBe(`project:${first.projectId}`)
  })

  it('treats raw and host-qualified filter entries independently', () => {
    const matches = projectRepoFilterMatcher(['first', 'runtime:server\0first'])
    expect(matches('first', 'runtime:server')).toBe(true)
    expect(matches('first', 'local')).toBe(true)
    const qualified = projectRepoFilterMatcher(['runtime:server\0first', 'second'])
    expect(qualified('first', 'local')).toBe(false)
    expect(qualified('second', 'local')).toBe(true)
  })

  it('carries overrides through identity succession without removing offline projects', () => {
    expect(
      carryProjectGroupingOverrides({ old: 'folder', offline: 'host' }, new Map([['old', 'new']]))
    ).toEqual({ new: 'folder', offline: 'host' })
  })
})
