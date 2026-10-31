import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { buildProjectGroups } from '../../../../shared/project-grouping'
import { getTaskProjectPickerGroups } from '../task-page/task-page-default-repo-selection'
import { resolveProjectCloneUrlPrefill } from '@/lib/project-clone-url-prefill'
import {
  getAutomationProjectGroupForRepo,
  getAutomationProjectGroups,
  getAutomationProjectSelectedSource
} from './automation-project-groups'

function repo(overrides: Partial<Repo>): Repo {
  return {
    id: overrides.id ?? 'repo-1',
    displayName: overrides.displayName ?? 'repo',
    path: overrides.path ?? '/repo',
    kind: 'git',
    addedAt: overrides.addedAt ?? 1,
    badgeColor: overrides.badgeColor ?? '#777777',
    connectionId: overrides.connectionId ?? null,
    executionHostId: overrides.executionHostId,
    upstream: overrides.upstream,
    repoIcon: overrides.repoIcon
  } as Repo
}

describe('getAutomationProjectGroups', () => {
  it('keeps alias selection in the same physical group across pickers and clone prefill', () => {
    const pending = repo({ id: 'pending', path: '/repos/app' })
    const identified: Repo = {
      ...pending,
      id: 'identified',
      gitRemoteIdentity: {
        canonicalKey: 'gitlab.com/org/app',
        remoteName: 'origin',
        remoteUrl: 'https://gitlab.com/org/app.git'
      }
    }
    const repos = [
      pending,
      identified,
      { ...identified, id: 'second', path: '/repos/second' },
      { ...identified, executionHostId: 'runtime:server' as const }
    ]
    const projection = projectHostSetupProjectionFromRepos(repos)
    for (const mode of ['repository', 'host', 'folder'] as const) {
      const settings = { projectGroupingMode: mode }
      const expected = buildProjectGroups(
        { projects: projection.projects, projectHostSetups: projection.setups },
        settings
      ).map((group) => group.key)
      const groups = getAutomationProjectGroups(repos, 'pending', settings)
      expect(groups.map((group) => group.projectKey)).toEqual(expected)
      const chosen = getAutomationProjectGroupForRepo(groups, 'pending')
      expect(chosen?.repo.id).toBe('pending')
      expect(chosen?.sources.map((source) => source.id)).toContain('identified')
      expect(
        getTaskProjectPickerGroups(repos, new Set(['pending']), settings).map(
          (group) => group.projectKey
        )
      ).toEqual(expected)
      expect(
        resolveProjectCloneUrlPrefill(
          projection.projects,
          repos,
          chosen?.projectKey ?? null,
          settings
        )
      ).toBe('https://gitlab.com/org/app.git')
    }
  })

  it('groups same logical project sources under one row', () => {
    const groups = getAutomationProjectGroups(
      [
        repo({
          id: 'local',
          displayName: 'claude-swap',
          path: '/Users/me/claude-swap',
          repoIcon: { type: 'image', source: 'github', label: 'realiti4/claude-swap', src: '' }
        }),
        repo({
          id: 'ssh',
          displayName: 'claude-swap',
          path: '/home/orca/claude-swap',
          connectionId: 'docker',
          repoIcon: { type: 'image', source: 'github', label: 'realiti4/claude-swap', src: '' }
        }),
        repo({
          id: 'other',
          displayName: 'other',
          path: '/other'
        })
      ],
      'ssh'
    )

    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({
      projectKey: 'project:github:realiti4/claude-swap',
      repo: { id: 'ssh' }
    })
    expect(groups[0]?.sources.map((source) => source.id)).toEqual(['local', 'ssh'])
  })

  it('finds and preserves the selected concrete source', () => {
    const groups = getAutomationProjectGroups(
      [
        repo({ id: 'local', upstream: { owner: 'stablyai', repo: 'orca' } }),
        repo({
          id: 'ssh',
          connectionId: 'builder',
          upstream: { owner: 'stablyai', repo: 'orca' }
        })
      ],
      'ssh'
    )
    const group = getAutomationProjectGroupForRepo(groups, 'ssh')

    expect(group).not.toBeNull()
    expect(group ? getAutomationProjectSelectedSource(group, 'ssh').id : null).toBe('ssh')
  })
})
