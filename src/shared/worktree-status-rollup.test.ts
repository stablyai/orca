import { describe, expect, it } from 'vitest'
import {
  mergeWorktreeRollupStatus,
  rollUpWorktreeStatus,
  worktreeStatusRank,
  type WorktreeRollupStatus
} from './worktree-status-rollup'

const LADDER: readonly WorktreeRollupStatus[] = [
  'inactive',
  'active',
  'done',
  'interrupted',
  'monitoring',
  'working',
  'permission'
]

describe('the rollup ladder', () => {
  it('ranks every status strictly, lowest first', () => {
    const ranks = LADDER.map(worktreeStatusRank)
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    expect(new Set(ranks).size).toBe(LADDER.length)
  })

  it('preserves the wire subset ordering `worktree ps` shipped before the ladder was shared', () => {
    // Pin: the RuntimeWorktreeStatus members must keep permission > working > done > active >
    // inactive, so folding the renderer's extra members in cannot reorder the CLI's rollup.
    const wireSubset: readonly WorktreeRollupStatus[] = [
      'inactive',
      'active',
      'done',
      'working',
      'permission'
    ]
    expect([...wireSubset].sort((a, b) => worktreeStatusRank(b) - worktreeStatusRank(a))).toEqual([
      'permission',
      'working',
      'done',
      'active',
      'inactive'
    ])
  })

  it('keeps live work above a terminal outcome, and an interrupt above success', () => {
    expect(mergeWorktreeRollupStatus('interrupted', 'working')).toBe('working')
    expect(mergeWorktreeRollupStatus('working', 'interrupted')).toBe('working')
    expect(mergeWorktreeRollupStatus('interrupted', 'monitoring')).toBe('monitoring')
    expect(mergeWorktreeRollupStatus('done', 'interrupted')).toBe('interrupted')
    expect(mergeWorktreeRollupStatus('interrupted', 'done')).toBe('interrupted')
  })

  it('returns the higher-ranked of any pair, whichever side it arrives on', () => {
    for (const left of LADDER) {
      for (const right of LADDER) {
        const higher = worktreeStatusRank(left) >= worktreeStatusRank(right) ? left : right
        expect(mergeWorktreeRollupStatus(left, right), `${left} + ${right}`).toBe(higher)
        expect(mergeWorktreeRollupStatus(right, left), `${right} + ${left}`).toBe(higher)
      }
    }
  })
})

describe('rollUpWorktreeStatus', () => {
  it('returns the base when no candidate outranks it', () => {
    expect(rollUpWorktreeStatus<WorktreeRollupStatus>('working', ['done', 'active'])).toBe(
      'working'
    )
  })

  it('lets a caller pass `flag && status` without an unset flag reaching the ladder', () => {
    // Ergonomics, not adjudication: an unset flag must contribute nothing, so a reader can list
    // its signals in any order instead of hand-writing a precedence if-chain.
    const hasPermission = false
    const hasDone = true
    expect(
      rollUpWorktreeStatus<WorktreeRollupStatus>('active', [
        hasPermission && 'permission',
        hasDone && 'done',
        null,
        undefined
      ])
    ).toBe('done')
    expect(rollUpWorktreeStatus<WorktreeRollupStatus>('working', [false, null, undefined])).toBe(
      'working'
    )
  })

  it('takes the highest candidate regardless of the order they are passed', () => {
    expect(
      rollUpWorktreeStatus<WorktreeRollupStatus>('inactive', ['done', 'permission', 'working'])
    ).toBe('permission')
    expect(
      rollUpWorktreeStatus<WorktreeRollupStatus>('inactive', ['permission', 'working', 'done'])
    ).toBe('permission')
  })
})
