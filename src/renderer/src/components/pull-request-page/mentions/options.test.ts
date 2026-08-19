import { describe, expect, it } from 'vitest'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { buildMentionOptions } from './options'

const item = {
  author: 'octocat',
  type: 'pr'
} as GitHubWorkItem

function comment(author: string, authorAvatarUrl?: string): PRComment {
  return { author, authorAvatarUrl } as PRComment
}

function user(login: string, extras: Partial<GitHubAssignableUser> = {}): GitHubAssignableUser {
  return { login, name: extras.name ?? null, avatarUrl: extras.avatarUrl ?? '' }
}

describe('buildMentionOptions', () => {
  it('includes the item author, commenters, participants, and assignable users', () => {
    const options = buildMentionOptions({
      item,
      comments: [comment('reviewer', 'https://avatars/reviewer')],
      participants: [user('helper', { name: 'Helper' })],
      assignableUsers: [user('teammate')]
    })

    expect(options.map((option) => option.login)).toEqual([
      'octocat',
      'reviewer',
      'helper',
      'teammate'
    ])
    expect(options[0]?.source).toBe('PR author')
    expect(options[1]?.avatarUrl).toBe('https://avatars/reviewer')
    expect(options[2]?.name).toBe('Helper')
  })

  it('skips ghost and fills missing avatar/name on a later case-insensitive duplicate login', () => {
    const options = buildMentionOptions({
      item,
      comments: [comment('ghost'), comment('Octocat', 'https://avatars/octocat')],
      participants: [user('OCTOCAT', { name: 'Mona' })],
      assignableUsers: []
    })

    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({
      login: 'octocat',
      avatarUrl: 'https://avatars/octocat',
      name: 'Mona'
    })
  })
})
