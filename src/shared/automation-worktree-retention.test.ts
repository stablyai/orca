import { describe, expect, it } from 'vitest'
import {
  formatAutomationWorktreeRetention,
  interpretAutomationWorktreeRetention,
  normalizeStoredAutomationWorktreeRetention,
  parseAutomationWorktreeRetentionFlag,
  resolveAutomationWorktreeRetention,
  selectAutomationWorktreesToReclaim,
  type AutomationWorktreeRetentionCandidate
} from './automation-worktree-retention'

function candidate(
  overrides: Partial<AutomationWorktreeRetentionCandidate> &
    Pick<AutomationWorktreeRetentionCandidate, 'id' | 'automationRunId'>
): AutomationWorktreeRetentionCandidate {
  return {
    createdAt: 1,
    isMainWorktree: false,
    safety: 'reclaimable',
    ...overrides
  }
}

describe('automation worktree retention', () => {
  it('defaults new-per-run to reclaiming only a clean success and keeps existing workspaces', () => {
    expect(resolveAutomationWorktreeRetention('new_per_run', undefined)).toEqual({
      mode: 'reclaim_clean_success'
    })
    expect(
      resolveAutomationWorktreeRetention('existing', { mode: 'reclaim_clean_success' })
    ).toEqual({
      mode: 'keep'
    })
  })

  it('treats an unrecognized stored mode as keep and a missing value as the default', () => {
    expect(interpretAutomationWorktreeRetention({ mode: 'archive_later' })).toEqual({
      mode: 'keep'
    })
    expect(normalizeStoredAutomationWorktreeRetention({ mode: 'nope' })).toEqual({ mode: 'keep' })
    expect(normalizeStoredAutomationWorktreeRetention(undefined)).toBeUndefined()
    expect(normalizeStoredAutomationWorktreeRetention({ mode: 'keep_last', count: 0 })).toEqual({
      mode: 'keep'
    })
    expect(parseAutomationWorktreeRetentionFlag('keep-last:3')).toEqual({
      mode: 'keep_last',
      count: 3
    })
    expect(parseAutomationWorktreeRetentionFlag('default')).toBeNull()
    expect(parseAutomationWorktreeRetentionFlag('wipe')).toBe('invalid')
  })

  it('removes clean successes and leaves dirty, unique, unverifiable, and failed runs', () => {
    const statuses = new Map<string, string>([
      ['ok', 'completed'],
      ['dirty-run', 'completed'],
      ['unique-run', 'completed'],
      ['unknown-run', 'completed'],
      ['failed-run', 'dispatch_failed']
    ])
    expect(
      selectAutomationWorktreesToReclaim({
        policy: { mode: 'reclaim_clean_success' },
        listingTruncated: false,
        finishedRunId: 'ok',
        runStatusById: statuses,
        candidates: [
          candidate({ id: 'clean', automationRunId: 'ok' }),
          candidate({ id: 'dirty', automationRunId: 'dirty-run', safety: 'keep' }),
          candidate({ id: 'unique', automationRunId: 'unique-run', safety: 'keep' }),
          candidate({ id: 'lost', automationRunId: 'unknown-run', safety: 'unverifiable' }),
          candidate({ id: 'failed', automationRunId: 'failed-run' }),
          candidate({ id: 'primary', automationRunId: 'ok', isMainWorktree: true })
        ]
      })
    ).toEqual(['clean'])
  })

  it('keeps the newest N worktrees and still refuses to delete unsafe older ones', () => {
    const statuses = new Map<string, string>([
      ['new', 'completed'],
      ['old-clean', 'completed'],
      ['old-dirty', 'completed']
    ])
    expect(
      selectAutomationWorktreesToReclaim({
        policy: { mode: 'keep_last', count: 1 },
        listingTruncated: false,
        finishedRunId: 'new',
        runStatusById: statuses,
        candidates: [
          candidate({ id: 'newest', automationRunId: 'new', createdAt: 30 }),
          candidate({ id: 'older-clean', automationRunId: 'old-clean', createdAt: 20 }),
          candidate({
            id: 'older-dirty',
            automationRunId: 'old-dirty',
            createdAt: 10,
            safety: 'keep'
          })
        ]
      })
    ).toEqual(['older-clean'])
  })

  it('does not evict from a truncated listing except the finished clean success', () => {
    const statuses = new Map<string, string>([
      ['now', 'completed'],
      ['old', 'completed']
    ])
    const candidates = [
      candidate({ id: 'current', automationRunId: 'now', createdAt: 2 }),
      candidate({ id: 'previous', automationRunId: 'old', createdAt: 1 })
    ]
    expect(
      selectAutomationWorktreesToReclaim({
        policy: { mode: 'keep_last', count: 1 },
        listingTruncated: true,
        finishedRunId: 'now',
        runStatusById: statuses,
        candidates
      })
    ).toEqual([])
    expect(
      selectAutomationWorktreesToReclaim({
        policy: { mode: 'reclaim_clean_success' },
        listingTruncated: true,
        finishedRunId: 'now',
        runStatusById: statuses,
        candidates
      })
    ).toEqual(['current'])
  })

  it('describes the default without pretending a policy was saved', () => {
    expect(formatAutomationWorktreeRetention('new_per_run', undefined)).toBe(
      'reclaim_clean_success (default)'
    )
    expect(formatAutomationWorktreeRetention('new_per_run', { mode: 'keep' })).toBe('keep')
  })
})
