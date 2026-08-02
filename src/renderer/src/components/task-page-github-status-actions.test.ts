import { describe, expect, it } from 'vitest'
import {
  buildTaskPageGitHubCloseUpdate,
  getTaskPageGitHubDuplicateCandidates,
  getTaskPageGitHubDuplicateTargetErrorMessage,
  validateTaskPageGitHubDuplicateTarget
} from './task-page-github-status-actions'
import type { GitHubWorkItem } from '../../../shared/types'

describe('TaskPage GitHub status actions', () => {
  it('builds completed and not planned close updates', () => {
    expect(buildTaskPageGitHubCloseUpdate({ stateReason: 'completed' })).toEqual({
      state: 'closed',
      stateReason: 'completed'
    })
    expect(buildTaskPageGitHubCloseUpdate({ stateReason: 'not_planned' })).toEqual({
      state: 'closed',
      stateReason: 'not_planned'
    })
  })

  it('builds duplicate close updates with a target issue number', () => {
    expect(buildTaskPageGitHubCloseUpdate({ stateReason: 'duplicate', duplicateOf: 42 })).toEqual({
      state: 'closed',
      stateReason: 'duplicate',
      duplicateOf: 42
    })
  })

  it('validates duplicate targets before dispatch', () => {
    expect(validateTaskPageGitHubDuplicateTarget('', 12).ok).toBe(false)
    expect(validateTaskPageGitHubDuplicateTarget('12', 12).ok).toBe(false)
    expect(validateTaskPageGitHubDuplicateTarget('12.5', 12).ok).toBe(false)
    expect(validateTaskPageGitHubDuplicateTarget('-1', 12).ok).toBe(false)
    expect(validateTaskPageGitHubDuplicateTarget('0', 12).ok).toBe(false)
    expect(validateTaskPageGitHubDuplicateTarget('  34 ', 12)).toEqual({
      ok: true,
      duplicateOf: 34
    })
  })

  it('maps duplicate validation failures to localized messages', () => {
    const t = (_key: string, fallback: string): string => fallback
    const validation = validateTaskPageGitHubDuplicateTarget('same', 12)

    expect(validation.ok).toBe(false)
    if (!validation.ok) {
      expect(getTaskPageGitHubDuplicateTargetErrorMessage(validation, t)).toBe(
        'Use a whole issue number.'
      )
    }
  })

  it('filters duplicate candidates to other matching issues', () => {
    const items = [
      buildWorkItem({ number: 12, title: 'Current issue', type: 'issue' }),
      buildWorkItem({ number: 34, title: 'Copy SSH file support', type: 'issue' }),
      buildWorkItem({ number: 56, title: 'Unrelated pull request', type: 'pr' }),
      buildWorkItem({ number: 78, title: 'Windows path copy bug', type: 'issue' })
    ]

    expect(getTaskPageGitHubDuplicateCandidates(items, 12, '').map((item) => item.number)).toEqual([
      34, 78
    ])
    expect(
      getTaskPageGitHubDuplicateCandidates(items, 12, 'copy').map((item) => item.number)
    ).toEqual([34, 78])
    expect(
      getTaskPageGitHubDuplicateCandidates(items, 12, '34').map((item) => item.number)
    ).toEqual([34])
  })
})

function buildWorkItem(overrides: Partial<GitHubWorkItem>): GitHubWorkItem {
  return {
    id: `item-${overrides.number ?? 1}`,
    type: 'issue',
    number: 1,
    title: 'Issue',
    state: 'open',
    url: 'https://github.com/stablyai/orca/issues/1',
    labels: [],
    updatedAt: '2026-06-22T00:00:00.000Z',
    author: null,
    repoId: 'repo-1',
    ...overrides
  }
}
