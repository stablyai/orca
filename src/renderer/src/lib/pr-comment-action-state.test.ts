import { describe, expect, it } from 'vitest'
import type { PRComment } from '../../../shared/types'
import { groupPRComments } from './pr-comment-groups'
import {
  getPRCommentGroupActionState,
  isPRCommentGroupQueueableForAI,
  partitionPRCommentGroupsForTriage,
  sortPRCommentGroupsForTimeline
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

  it('sorts comment groups chronologically for timeline mode', () => {
    const groups = groupPRComments([
      comment({ id: 3, createdAt: '2026-06-16T12:00:00Z', body: 'third' }),
      comment({ id: 1, createdAt: '2026-06-16T10:00:00Z', body: 'first' }),
      comment({ id: 2, createdAt: '2026-06-16T11:00:00Z', body: 'second' })
    ])
    const sorted = sortPRCommentGroupsForTimeline(groups)

    expect(sorted.map((group) => getPRCommentGroupActionState(group))).toEqual([
      'conversation',
      'conversation',
      'conversation'
    ])
    expect(
      sorted.map((group) => (group.kind === 'standalone' ? group.comment.body : group.root.body))
    ).toEqual(['first', 'second', 'third'])
  })
})
