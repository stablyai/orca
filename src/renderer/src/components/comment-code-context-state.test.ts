import { describe, expect, it } from 'vitest'
import {
  createCommentCodeContextExpansionState,
  resolveCommentCodeContextExpansionState,
  updateCommentCodeContextExpansionState
} from './comment-code-context-state'

describe('comment code context expansion state', () => {
  it('keeps expanded context for the same comment', () => {
    const expanded = updateCommentCodeContextExpansionState(
      createCommentCodeContextExpansionState('comment-1'),
      'comment-1',
      {
        contextBefore: 5,
        contextAfter: 3
      }
    )

    expect(resolveCommentCodeContextExpansionState(expanded, 'comment-1')).toEqual({
      commentId: 'comment-1',
      contextBefore: 5,
      contextAfter: 3
    })
  })

  it('resets expansion when a rendered row switches comments', () => {
    const expanded = updateCommentCodeContextExpansionState(
      createCommentCodeContextExpansionState('comment-1'),
      'comment-1',
      {
        contextBefore: 5,
        contextAfter: 3
      }
    )

    expect(resolveCommentCodeContextExpansionState(expanded, 'comment-2')).toEqual({
      commentId: 'comment-2',
      contextBefore: 0,
      contextAfter: 0
    })
  })

  it('applies functional updates after resolving stale comment state', () => {
    const expanded = updateCommentCodeContextExpansionState(
      createCommentCodeContextExpansionState('comment-1'),
      'comment-1',
      {
        contextBefore: 5,
        contextAfter: 3
      }
    )

    expect(
      updateCommentCodeContextExpansionState(expanded, 'comment-2', {
        contextBefore: (current) => current + 2,
        contextAfter: (current) => current + 4
      })
    ).toEqual({
      commentId: 'comment-2',
      contextBefore: 2,
      contextAfter: 4
    })
  })
})
