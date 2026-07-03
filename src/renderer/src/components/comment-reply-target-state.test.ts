import { describe, expect, it } from 'vitest'
import {
  getCommentReplyTargetCandidates,
  resolveCommentReplyTarget
} from './comment-reply-target-state'

describe('comment reply target state', () => {
  it('preserves a visible reply target', () => {
    expect(resolveCommentReplyTarget(2, [{ id: 1 }, { id: 2 }])).toBe(2)
  })

  it('clears a hidden reply target', () => {
    expect(resolveCommentReplyTarget(3, [{ id: 1 }, { id: 2 }])).toBeNull()
  })

  it('keeps an empty reply target empty', () => {
    expect(resolveCommentReplyTarget(null, [{ id: 1 }])).toBeNull()
  })

  it('uses filtered comments as reply targets for PRs', () => {
    expect(getCommentReplyTargetCandidates('pr', [{ id: 1 }, { id: 2 }], [{ id: 2 }])).toEqual([
      { id: 2 }
    ])
  })

  it('uses all comments as reply targets for issues', () => {
    expect(getCommentReplyTargetCandidates('issue', [{ id: 1 }, { id: 2 }], [{ id: 2 }])).toEqual([
      { id: 1 },
      { id: 2 }
    ])
  })
})
