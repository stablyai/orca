import { describe, expect, it } from 'vitest'
import {
  matchKanbanTaskRepository,
  type KanbanRepoCandidate
} from './task-page-kanban-repo-project-match'

function repo(id: string, remoteUrl: string): KanbanRepoCandidate {
  return { id, gitRemoteIdentity: { remoteUrl } }
}

const WIDGETS_HTTPS = 'https://github.com/acme/widgets'
const WIDGETS_GIT = 'https://github.com/acme/widgets.git'
const WIDGETS_SCP = 'git@github.com:acme/widgets.git'
const WIDGETS_SCP_TRAILING = 'git@github.com:acme/widgets/'

describe('matchKanbanTaskRepository', () => {
  it('matches an HTTPS card URL against an identical HTTPS remote, ignoring .git', () => {
    const result = matchKanbanTaskRepository({
      repositoryUrls: [WIDGETS_HTTPS],
      repos: [repo('repo-widgets', WIDGETS_GIT)]
    })
    expect(result).toEqual({ kind: 'unique', repo: { id: 'repo-widgets', gitRemoteIdentity: { remoteUrl: WIDGETS_GIT } } })
  })

  it('matches an SSH/SCP card URL against an HTTPS remote', () => {
    const result = matchKanbanTaskRepository({
      repositoryUrls: [WIDGETS_SCP],
      repos: [repo('repo-widgets', WIDGETS_HTTPS)]
    })
    expect(result.kind).toBe('unique')
    if (result.kind === 'unique') {
      expect(result.repo.id).toBe('repo-widgets')
    }
  })

  it('ignores a trailing slash and .git on both sides', () => {
    const result = matchKanbanTaskRepository({
      repositoryUrls: [WIDGETS_SCP_TRAILING],
      repos: [repo('repo-widgets', WIDGETS_GIT)]
    })
    expect(result.kind).toBe('unique')
    if (result.kind === 'unique') {
      expect(result.repo.id).toBe('repo-widgets')
    }
  })

  it('matches GitHub paths case-insensitively', () => {
    const result = matchKanbanTaskRepository({
      repositoryUrls: ['https://github.com/Acme/Widgets'],
      repos: [repo('repo-widgets', WIDGETS_GIT)]
    })
    expect(result.kind).toBe('unique')
    if (result.kind === 'unique') {
      expect(result.repo.id).toBe('repo-widgets')
    }
  })

  it('keeps GitLab paths case-sensitive', () => {
    const result = matchKanbanTaskRepository({
      repositoryUrls: ['https://gitlab.com/Acme/Widgets'],
      repos: [repo('repo-widgets', 'https://gitlab.com/acme/widgets.git')]
    })
    expect(result.kind).toBe('none')
  })

  it('returns none when no Orca repo matches the card repository', () => {
    const result = matchKanbanTaskRepository({
      repositoryUrls: [WIDGETS_HTTPS],
      repos: [repo('repo-other', 'https://github.com/other/project.git')]
    })
    expect(result).toEqual({ kind: 'none' })
  })

  it('returns multiple when two Orca repos match the same card repository', () => {
    const result = matchKanbanTaskRepository({
      repositoryUrls: [WIDGETS_SCP],
      repos: [repo('repo-a', WIDGETS_HTTPS), repo('repo-b', WIDGETS_GIT)]
    })
    expect(result).toEqual({ kind: 'multiple' })
  })

  it('returns multiple when the card lists several distinct repositories', () => {
    const result = matchKanbanTaskRepository({
      repositoryUrls: [WIDGETS_HTTPS, 'https://gitlab.com/acme/widgets.git'],
      repos: [repo('repo-widgets', WIDGETS_GIT)]
    })
    expect(result).toEqual({ kind: 'multiple' })
  })

  it('returns none when the card has no repository', () => {
    const result = matchKanbanTaskRepository({
      repositoryUrls: [],
      repos: [repo('repo-widgets', WIDGETS_GIT)]
    })
    expect(result).toEqual({ kind: 'none' })
  })

  it('returns none when the card repository cannot be parsed', () => {
    const result = matchKanbanTaskRepository({
      repositoryUrls: ['C:/Users/me/local-checkout'],
      repos: [repo('repo-widgets', WIDGETS_GIT)]
    })
    expect(result).toEqual({ kind: 'none' })
  })

  it('never matches a different provider even on the same path', () => {
    const result = matchKanbanTaskRepository({
      repositoryUrls: ['https://gitlab.com/acme/widgets'],
      repos: [repo('repo-widgets', WIDGETS_GIT)]
    })
    expect(result.kind).toBe('none')
  })
})