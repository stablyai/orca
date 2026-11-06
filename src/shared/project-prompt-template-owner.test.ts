import { describe, expect, it } from 'vitest'
import { getProjectPromptTemplateOwner } from './project-prompt-template-owner'

const project = { id: 'project', sourceRepoIds: [] }

describe('project prompt template config owner', () => {
  it('prefers the local catalog including direct SSH regardless of setup order', () => {
    for (const hostId of ['local', 'ssh:host'] as const) {
      const setups = [
        { projectId: 'project', hostId: 'runtime:remote' as const },
        { projectId: 'project', hostId }
      ]
      expect(getProjectPromptTemplateOwner(project, setups, [])).toBe('local')
      expect(getProjectPromptTemplateOwner(project, setups.toReversed(), [])).toBe('local')
    }
  })

  it('chooses a stable remote catalog and ignores unrelated projects', () => {
    const setups = [
      { projectId: 'other', hostId: 'local' as const },
      { projectId: 'project', hostId: 'runtime:z' as const },
      { projectId: 'project', hostId: 'runtime:a' as const }
    ]
    expect(getProjectPromptTemplateOwner(project, setups, [])).toBe('runtime:a')
    expect(getProjectPromptTemplateOwner(project, setups.toReversed(), [])).toBe('runtime:a')
    expect(getProjectPromptTemplateOwner(project, [], [])).toBeUndefined()
  })

  it.each(['local', 'ssh:other', 'runtime:a'] as const)(
    'ignores a duplicate repo ID belonging to another project on %s',
    (hostId) => {
      const remoteProject = { id: 'github:remote/app', sourceRepoIds: ['same-id'] }
      const setups = [
        { projectId: 'github:other/app', hostId },
        { projectId: remoteProject.id, hostId: 'runtime:server' as const }
      ]
      const repo = {
        id: 'same-id',
        path: '/repo',
        displayName: 'Repo',
        badgeColor: '',
        addedAt: 1
      }
      expect(
        getProjectPromptTemplateOwner(remoteProject, setups, [
          { ...repo, executionHostId: hostId, upstream: { owner: 'other', repo: 'app' } },
          {
            ...repo,
            executionHostId: 'runtime:server',
            upstream: { owner: 'remote', repo: 'app' }
          }
        ])
      ).toBe('runtime:server')
    }
  )
})
