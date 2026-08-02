import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/types'
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
      projectKey: 'github:realiti4/claude-swap',
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
