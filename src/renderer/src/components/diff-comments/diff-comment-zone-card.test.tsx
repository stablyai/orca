import { describe, expect, it } from 'vitest'
import { getRenderSignature } from './diff-comment-zone-card'
import type { DecoratedDiffComment } from './decorated-diff-comment'

const base: DecoratedDiffComment = {
  id: 'github-pr-thread:T1',
  worktreeId: 'github-pr:repo:1',
  filePath: 'src/a.ts',
  lineNumber: 10,
  body: 'root body',
  createdAt: 1,
  side: 'modified',
  author: 'alice'
}

describe('getRenderSignature review threads', () => {
  it('changes when replies are added', () => {
    const withReply: DecoratedDiffComment = {
      ...base,
      reviewThread: {
        isResolved: false,
        replies: [{ id: 'c2', body: 'a reply', author: 'bob' }]
      }
    }
    expect(getRenderSignature(withReply)).not.toBe(getRenderSignature(base))
  })

  it('changes when resolution flips', () => {
    const resolved: DecoratedDiffComment = {
      ...base,
      reviewThread: { isResolved: true, replies: [] }
    }
    const unresolved: DecoratedDiffComment = {
      ...base,
      reviewThread: { isResolved: false, replies: [] }
    }
    expect(getRenderSignature(resolved)).not.toBe(getRenderSignature(unresolved))
  })

  it('changes when a reply body is edited', () => {
    const before: DecoratedDiffComment = {
      ...base,
      reviewThread: { isResolved: false, replies: [{ id: 'c2', body: 'first' }] }
    }
    const after: DecoratedDiffComment = {
      ...base,
      reviewThread: { isResolved: false, replies: [{ id: 'c2', body: 'edited' }] }
    }
    expect(getRenderSignature(after)).not.toBe(getRenderSignature(before))
  })
})
