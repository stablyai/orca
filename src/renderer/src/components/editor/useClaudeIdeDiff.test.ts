import { describe, it, expect } from 'vitest'
import { reduceIdeDiffRequest } from './useClaudeIdeDiff'

describe('reduceIdeDiffRequest', () => {
  it('queues an incoming openDiff request', () => {
    const state = reduceIdeDiffRequest({ requests: [] }, { type: 'open', requestId: 'r1', worktreeId: 'wt', oldPath: '/a', newPath: '/a', newContents: 'x' })
    expect(state.requests).toHaveLength(1)
    expect(state.requests[0].requestId).toBe('r1')
  })

  it('removes a request once resolved', () => {
    const open = reduceIdeDiffRequest({ requests: [] }, { type: 'open', requestId: 'r1', worktreeId: 'wt', oldPath: '/a', newPath: '/a', newContents: 'x' })
    const closed = reduceIdeDiffRequest(open, { type: 'resolve', requestId: 'r1' })
    expect(closed.requests).toHaveLength(0)
  })
})
