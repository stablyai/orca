import { expect, it } from 'vitest'
import type { PRComment } from '../../github/comments/comment-types'
import { buildPRCommentsResolutionPrompt } from './pr-comments-resolution-prompt'

it('serializes selected thread content once while preserving replies and standalone feedback', () => {
  const root: PRComment = {
    id: 11,
    author: 'reviewer',
    authorAvatarUrl: '',
    body: 'Check missing workspace names',
    createdAt: '',
    url: '',
    threadId: 'discussion-1',
    isResolved: false
  }
  const prompt = buildPRCommentsResolutionPrompt({
    reviewKind: 'MR',
    reviewNumber: 42,
    reviewTitle: 'Workspace labels',
    reviewUrl: 'https://gitlab.example/repo/-/merge_requests/42',
    groups: [
      {
        kind: 'thread',
        threadId: 'discussion-1',
        root,
        replies: [{ ...root, id: 12, body: 'Include older remote hosts' }]
      },
      { kind: 'standalone', comment: { ...root, id: 13, body: 'Check cleanup sorting' } }
    ]
  })
  const serialized = prompt.split('Selected comment data JSON:\n')[1]!.split('\n\nRules:')[0]!
  const payload = JSON.parse(serialized)

  expect(payload).not.toHaveProperty('hostResolvableThreads')
  expect(payload.selectedCommentGroups).toMatchObject([
    {
      kind: 'thread',
      threadId: 'discussion-1',
      isHostResolvable: true,
      root: { id: 11, body: 'Check missing workspace names' },
      replies: [{ id: 12, body: 'Include older remote hosts' }]
    },
    { kind: 'standalone', comment: { id: 13, body: 'Check cleanup sorting' } }
  ])
})
