import { describe, expect, it, vi } from 'vitest'
import {
  getTaskPageGitHubPRIconTone,
  getTaskPageGitHubWorkItemStateLabel,
  getTaskPageGitHubWorkItemStateTone,
  isTaskPageGitHubDraftPR
} from './task-page-github-work-item-status'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

describe('task-page-github-work-item-status', () => {
  it('maps PR states to labels', () => {
    expect(getTaskPageGitHubWorkItemStateLabel({ type: 'pr', state: 'draft' })).toBe('Draft')
    expect(getTaskPageGitHubWorkItemStateLabel({ type: 'pr', state: 'open' })).toBe('Open')
    expect(getTaskPageGitHubWorkItemStateLabel({ type: 'pr', state: 'closed' })).toBe('Closed')
    expect(getTaskPageGitHubWorkItemStateLabel({ type: 'pr', state: 'merged' })).toBe('Merged')
  })

  it('maps issue states to labels', () => {
    expect(getTaskPageGitHubWorkItemStateLabel({ type: 'issue', state: 'open' })).toBe('Open')
    expect(getTaskPageGitHubWorkItemStateLabel({ type: 'issue', state: 'closed' })).toBe('Closed')
  })

  it('uses GitHub-like neutral draft tones and muted draft icons', () => {
    const draftTone = getTaskPageGitHubWorkItemStateTone({ type: 'pr', state: 'draft' })
    expect(draftTone).toContain('muted')
    expect(draftTone).not.toContain('amber')
    expect(getTaskPageGitHubPRIconTone({ type: 'pr', state: 'draft' })).toContain('muted')
    expect(getTaskPageGitHubPRIconTone({ type: 'pr', state: 'open' })).toContain('emerald')
    expect(isTaskPageGitHubDraftPR({ type: 'pr', state: 'draft' })).toBe(true)
    expect(isTaskPageGitHubDraftPR({ type: 'pr', state: 'open' })).toBe(false)
  })

  it('uses distinct muted tones for merged and open PRs', () => {
    const mergedTone = getTaskPageGitHubWorkItemStateTone({ type: 'pr', state: 'merged' })
    expect(mergedTone).toContain('purple')
    expect(mergedTone).toContain('text-purple-700')
    expect(mergedTone).not.toContain('bg-purple-600')

    const openTone = getTaskPageGitHubWorkItemStateTone({ type: 'pr', state: 'open' })
    expect(openTone).toContain('emerald')
    expect(openTone).toContain('text-emerald-700')
    expect(openTone).not.toContain('bg-emerald-600')
  })

  it('handles edge cases gracefully', () => {
    // Issues don't have draft state - should fallback to open styling
    expect(getTaskPageGitHubWorkItemStateLabel({ type: 'issue', state: 'open' })).toBe('Open')
    expect(getTaskPageGitHubWorkItemStateLabel({ type: 'issue', state: 'closed' })).toBe('Closed')

    // Unknown state should fallback to 'Open' for PRs
    expect(getTaskPageGitHubWorkItemStateLabel({ type: 'pr', state: 'unknown' as 'open' })).toBe(
      'Open'
    )

    // Icon tones for issues should always be muted
    expect(getTaskPageGitHubPRIconTone({ type: 'issue', state: 'open' })).toContain(
      'muted-foreground'
    )
    expect(getTaskPageGitHubPRIconTone({ type: 'issue', state: 'closed' })).toContain(
      'muted-foreground'
    )

    // Draft PR check
    expect(isTaskPageGitHubDraftPR({ type: 'pr', state: 'draft' })).toBe(true)
    expect(isTaskPageGitHubDraftPR({ type: 'pr', state: 'open' })).toBe(false)
    expect(isTaskPageGitHubDraftPR({ type: 'pr', state: 'merged' })).toBe(false)
    expect(isTaskPageGitHubDraftPR({ type: 'pr', state: 'closed' })).toBe(false)
    expect(isTaskPageGitHubDraftPR({ type: 'issue', state: 'open' })).toBe(false)
    expect(isTaskPageGitHubDraftPR({ type: 'issue', state: 'closed' })).toBe(false)
  })
})
