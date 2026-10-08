import { describe, expect, it } from 'vitest'
import { pickCompactProjectTargetWorktree } from './compact-project-activation'
import { worktree } from './worktree-list-groups-test-fixtures'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorktreeAttention } from './smart-attention'

function wt(id: string, lastActivityAt: number, isMainWorktree = false): Worktree {
  return { ...worktree, id, lastActivityAt, isMainWorktree }
}

describe('pickCompactProjectTargetWorktree', () => {
  const main = wt('main', 0, true)
  const recent = wt('recent', 500)
  const older = wt('older', 100)

  it('prefers the most attention-demanding workspace', () => {
    const attention = new Map<string, WorktreeAttention>([
      ['recent', { cls: 3, attentionTimestamp: 900 }],
      ['older', { cls: 1, attentionTimestamp: 10, cause: 'waiting' }]
    ])
    expect(pickCompactProjectTargetWorktree([main, recent, older], attention)?.id).toBe('older')
  })

  it('breaks attention ties by the most recent attention event', () => {
    const attention = new Map<string, WorktreeAttention>([
      ['recent', { cls: 2, attentionTimestamp: 10 }],
      ['older', { cls: 2, attentionTimestamp: 90 }]
    ])
    expect(pickCompactProjectTargetWorktree([main, recent, older], attention)?.id).toBe('older')
  })

  it('falls back to the most recently active workspace', () => {
    expect(pickCompactProjectTargetWorktree([main, older, recent], new Map())?.id).toBe('recent')
  })

  it('falls back to the primary workspace when nothing has activity', () => {
    expect(pickCompactProjectTargetWorktree([wt('a', 0), main], new Map())?.id).toBe('main')
  })
})
