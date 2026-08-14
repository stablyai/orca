import { describe, expect, it } from 'vitest'
import type { PRComment } from '../../../shared/github/comment-types'
import { groupPRComments, type PRCommentGroup } from '../../../shared/pr-comment-groups'
import {
  getPRCommentGroupActionState,
  isPRCommentGroupQueueableForAI,
  partitionPRCommentGroupsForTriage,
  sortPRCommentGroupsByRecency
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

function bodies(groups: readonly PRCommentGroup[]): string[] {
  return groups.map((group) => (group.kind === 'standalone' ? group.comment.body : group.root.body))
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
    const sorted = sortPRCommentGroupsByRecency(groups)

    expect(sorted.map((group) => getPRCommentGroupActionState(group))).toEqual([
      'conversation',
      'conversation',
      'conversation'
    ])
    expect(bodies(sorted)).toEqual(['first', 'second', 'third'])
  })

  it('sorts each triage section newest-first for grouped mode', () => {
    const groups = groupPRComments([
      comment({ id: 1, createdAt: '2026-06-16T10:00:00Z', body: 'first' }),
      comment({ id: 2, createdAt: '2026-06-16T11:00:00Z', body: 'second' }),
      comment({
        id: 3,
        createdAt: '2026-06-16T09:00:00Z',
        body: 'older open',
        threadId: 't-open-old',
        path: 'src/a.ts',
        isResolved: false
      }),
      comment({
        id: 4,
        createdAt: '2026-06-16T12:00:00Z',
        body: 'newer open',
        threadId: 't-open-new',
        path: 'src/b.ts',
        isResolved: false
      })
    ])
    const partitioned = partitionPRCommentGroupsForTriage(
      sortPRCommentGroupsByRecency(groups, 'newest-first')
    )

    expect(bodies(partitioned.conversation)).toEqual(['second', 'first'])
    expect(bodies(partitioned.open)).toEqual(['newer open', 'older open'])
    expect(partitioned.resolved).toEqual([])
  })

  it('ranks a stale thread by its newest reply under newest-first only', () => {
    const groups = groupPRComments([
      comment({
        id: 1,
        createdAt: '2026-06-13T09:00:00Z',
        body: 'stale root',
        threadId: 't-stale',
        path: 'src/a.ts',
        isResolved: false
      }),
      comment({
        id: 2,
        createdAt: '2026-06-16T12:00:00Z',
        body: 'fresh reply',
        threadId: 't-stale',
        path: 'src/a.ts',
        isResolved: false
      }),
      comment({ id: 3, createdAt: '2026-06-16T11:00:00Z', body: 'newer standalone' }),
      comment({
        id: 4,
        createdAt: '2026-06-14T09:00:00Z',
        body: 'mid root',
        threadId: 't-mid',
        path: 'src/b.ts',
        isResolved: false
      }),
      comment({
        id: 5,
        createdAt: '2026-06-14T10:00:00Z',
        body: 'mid reply',
        threadId: 't-mid',
        path: 'src/b.ts',
        isResolved: false
      })
    ])

    expect(bodies(sortPRCommentGroupsByRecency(groups, 'newest-first'))).toEqual([
      'stale root',
      'newer standalone',
      'mid root'
    ])
    expect(bodies(sortPRCommentGroupsByRecency(groups))).toEqual([
      'stale root',
      'mid root',
      'newer standalone'
    ])
  })

  it('inverts the id tiebreaker numerically when groups share a timestamp', () => {
    const groups = groupPRComments([
      comment({ id: 9, createdAt: '2026-06-16T12:00:00Z', body: 'batch a' }),
      comment({ id: 10, createdAt: '2026-06-16T12:00:00Z', body: 'batch b' })
    ])

    expect(bodies(sortPRCommentGroupsByRecency(groups))).toEqual(['batch a', 'batch b'])
    expect(bodies(sortPRCommentGroupsByRecency(groups, 'newest-first'))).toEqual([
      'batch b',
      'batch a'
    ])
  })

  it('sinks groups with an unparseable timestamp to the bottom in both orders', () => {
    const groups = groupPRComments([
      comment({ id: 1, createdAt: '', body: 'unknown time' }),
      comment({ id: 2, createdAt: '2026-06-16T10:00:00Z', body: 'older' }),
      comment({ id: 3, createdAt: '2026-06-16T11:00:00Z', body: 'newer' })
    ])

    expect(bodies(sortPRCommentGroupsByRecency(groups))).toEqual(['older', 'newer', 'unknown time'])
    expect(bodies(sortPRCommentGroupsByRecency(groups, 'newest-first'))).toEqual([
      'newer',
      'older',
      'unknown time'
    ])
  })
})
