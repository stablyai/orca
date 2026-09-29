import { describe, expect, it } from 'vitest'
import { giteaPRChecksToPRChecks, giteaIssueCommentsToPRComments } from './checks-panel-gitea'

describe('giteaPRChecksToPRChecks', () => {
  it('maps Gitea commit-status states to PR check conclusions', () => {
    const result = giteaPRChecksToPRChecks([
      { context: 'build', state: 'success', targetUrl: 'https://ci/build' },
      { context: 'lint', state: 'failure' },
      { context: 'deploy', state: 'error' },
      { context: 'flaky', state: 'warning' },
      { context: 'tests', state: 'pending' }
    ])

    expect(result).toEqual([
      { name: 'build', status: 'completed', conclusion: 'success', url: 'https://ci/build' },
      { name: 'lint', status: 'completed', conclusion: 'failure', url: null },
      { name: 'deploy', status: 'completed', conclusion: 'failure', url: null },
      { name: 'flaky', status: 'completed', conclusion: 'neutral', url: null },
      { name: 'tests', status: 'in_progress', conclusion: 'pending', url: null }
    ])
  })
})

describe('giteaIssueCommentsToPRComments', () => {
  it('maps conversation comments and omits thread/resolve fields', () => {
    const result = giteaIssueCommentsToPRComments([
      {
        id: 7,
        body: 'Looks good',
        createdAt: '2026-06-18T10:00:00Z',
        user: { id: 1, login: 'alice', avatarUrl: 'https://a/avatar' }
      }
    ])

    expect(result).toEqual([
      {
        id: 7,
        author: 'alice',
        authorAvatarUrl: 'https://a/avatar',
        body: 'Looks good',
        createdAt: '2026-06-18T10:00:00Z',
        url: ''
      }
    ])
    expect(result[0]).not.toHaveProperty('threadId')
  })
})
