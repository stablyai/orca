import { describe, expect, it } from 'vitest'
import {
  MobileWebTaskGitHubDetailResultSchema,
  MobileWebTaskGitHubUsersResultSchema
} from './task-detail-contract'
import { MobileWebTaskGitHubListResultSchema } from './task-list-contract'
import { MobileWebTaskProjectTablePageResultSchema } from './task-project-table-contract'

const AVATAR_URL = 'https://avatars.example/private-user.png'

describe('mobile web task avatar contracts', () => {
  it('removes GitHub user and review avatars from list results', () => {
    const result = MobileWebTaskGitHubListResultSchema.parse({
      items: [
        {
          id: 'issue-1',
          type: 'pr',
          number: 1,
          title: 'Keep hosted images inert',
          state: 'open',
          url: 'https://github.example/orca/pull/1',
          labels: [],
          updatedAt: '2026-07-27T00:00:00Z',
          author: 'ada',
          reviewRequests: [{ login: 'grace', name: 'Grace', avatarUrl: AVATAR_URL }],
          latestReviews: [{ login: 'linus', state: 'APPROVED', avatarUrl: AVATAR_URL }]
        }
      ]
    })

    expect(result.items[0]?.reviewRequests?.[0]?.avatarUrl).toBeNull()
    expect(result.items[0]?.latestReviews?.[0]?.avatarUrl).toBeNull()
    expect(JSON.stringify(result)).not.toContain(AVATAR_URL)
  })

  it('removes assignable-user, review, and comment avatars from detail results', () => {
    const users = MobileWebTaskGitHubUsersResultSchema.parse({
      users: [{ login: 'ada', name: 'Ada', avatarUrl: AVATAR_URL }]
    })
    const detail = MobileWebTaskGitHubDetailResultSchema.parse({
      body: 'Body',
      comments: [
        {
          id: 1,
          author: 'ada',
          authorAvatarUrl: AVATAR_URL,
          body: 'Comment'
        }
      ],
      assignees: [],
      reviewRequests: [{ login: 'grace', name: null, avatarUrl: AVATAR_URL }],
      latestReviews: [{ login: 'linus', state: 'COMMENTED', avatarUrl: AVATAR_URL }],
      checks: [],
      files: []
    })

    expect(users.users[0]?.avatarUrl).toBeNull()
    expect(detail.comments[0]?.authorAvatarUrl).toBeUndefined()
    expect(detail.reviewRequests?.[0]?.avatarUrl).toBeNull()
    expect(detail.latestReviews?.[0]?.avatarUrl).toBeNull()
    expect(JSON.stringify({ users, detail })).not.toContain(AVATAR_URL)
  })

  it('removes project assignee and user-field avatars from table pages', () => {
    const result = MobileWebTaskProjectTablePageResultSchema.parse({
      rows: [
        {
          id: 'item-1',
          itemType: 'ISSUE',
          content: {
            number: 1,
            title: 'Hosted project item',
            body: null,
            url: 'https://github.example/orca/issues/1',
            state: 'OPEN',
            isDraft: false,
            repository: 'orca/mobile',
            labels: [],
            assignees: [{ login: 'ada', name: 'Ada', avatarUrl: AVATAR_URL }],
            parentIssue: null
          },
          fieldValuesByFieldId: {
            reviewers: {
              kind: 'users',
              fieldId: 'reviewers',
              users: [{ login: 'grace', name: 'Grace', avatarUrl: AVATAR_URL }]
            }
          },
          updatedAt: '2026-07-27T00:00:00Z',
          position: 0
        }
      ],
      nextCursor: null
    })

    const row = result.rows[0]
    expect(row?.content.assignees[0]?.avatarUrl).toBeNull()
    const reviewers = row?.fieldValuesByFieldId.reviewers
    expect(reviewers?.kind).toBe('users')
    if (reviewers?.kind !== 'users') {
      throw new Error('expected users field')
    }
    expect(reviewers.users[0]?.avatarUrl).toBeNull()
    expect(JSON.stringify(result)).not.toContain(AVATAR_URL)
  })
})
