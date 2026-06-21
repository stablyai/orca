import { describe, expect, it } from 'vitest'
import type { PRComment } from '../../../shared/types'
import { groupPRComments } from './pr-comment-groups'
import {
  getPRCommentGroupActionState,
  isPRCommentGroupQueueableForAI,
  partitionPRCommentGroupsForTriage
} from './pr-comment-action-state'

function comment(overrides: Partial<PRComment> & { id: number }): PRComment {
  return {
    author: 'alice',
    authorAvatarUrl: '',
    body: 'body',
    createdAt: '2026-06-16T12:00:00Z',
    url: '',
    ...overrides
  }
}

describe('pr-comment-action-state', () => {
  it('classifies resolved, open review threads, and conversation comments', () => {
    const groups = groupPRComments([
      comment({ id: 1, threadId: 't-open', path: 'src/a.ts', isResolved: false }),
      comment({ id: 2, threadId: 't-resolved', path: 'src/b.ts', isResolved: true }),
      comment({ id: 3, body: 'General discussion' })
    ])

    expect(getPRCommentGroupActionState(groups[0]!)).toBe('open')
    expect(getPRCommentGroupActionState(groups[1]!)).toBe('resolved')
    expect(getPRCommentGroupActionState(groups[2]!)).toBe('conversation')
  })

  it('partitions groups for triage sections', () => {
    const groups = groupPRComments([
      comment({ id: 1, threadId: 't-open', path: 'src/a.ts', isResolved: false }),
      comment({ id: 2, body: 'FYI' }),
      comment({ id: 3, threadId: 't-resolved', path: 'src/b.ts', isResolved: true })
    ])
    expect(partitionPRCommentGroupsForTriage(groups)).toEqual({
      open: [groups[0]],
      conversation: [groups[1]],
      resolved: [groups[2]]
    })
  })

  it('treats unknown thread resolution as conversation, not open', () => {
    const [group] = groupPRComments([comment({ id: 1, threadId: 't-unknown', path: 'src/a.ts' })])
    expect(getPRCommentGroupActionState(group!)).toBe('conversation')
    expect(isPRCommentGroupQueueableForAI(group!)).toBe(true)
  })
})
