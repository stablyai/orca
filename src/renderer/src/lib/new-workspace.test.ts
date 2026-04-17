import { describe, expect, it } from 'vitest'
import { getWorkspaceSeedName } from './new-workspace'

describe('getWorkspaceSeedName', () => {
  it('prefers an explicit name', () => {
    expect(
      getWorkspaceSeedName({
        explicitName: 'my-workspace',
        prompt: 'anything',
        linkedIssueNumber: null,
        linkedPR: null
      })
    ).toBe('my-workspace')
  })

  it('uses linked issue/PR when no explicit name is provided', () => {
    expect(
      getWorkspaceSeedName({
        explicitName: '',
        prompt: '',
        linkedIssueNumber: 7,
        linkedPR: null
      })
    ).toBe('issue-7')
    expect(
      getWorkspaceSeedName({
        explicitName: '',
        prompt: '',
        linkedIssueNumber: null,
        linkedPR: 42
      })
    ).toBe('pr-42')
  })

  it('slugifies and truncates very long prompts', () => {
    const longPrompt =
      'Investigate the flaky login regression on iOS where the session cookie is dropped after background refresh and users get bounced to the splash screen.'
    const seed = getWorkspaceSeedName({
      explicitName: '',
      prompt: longPrompt,
      linkedIssueNumber: null,
      linkedPR: null
    })
    expect(seed.length).toBeLessThanOrEqual(48)
    expect(seed).toMatch(/^[a-z0-9._-]+$/)
    expect(seed.startsWith('investigate-the-flaky-login')).toBe(true)
  })

  it('falls back to "workspace" when a prompt has no sluggable characters', () => {
    expect(
      getWorkspaceSeedName({
        explicitName: '',
        prompt: '🚀🚀🚀',
        linkedIssueNumber: null,
        linkedPR: null
      })
    ).toBe('workspace')
    expect(
      getWorkspaceSeedName({
        explicitName: '',
        prompt: '日本語だけ',
        linkedIssueNumber: null,
        linkedPR: null
      })
    ).toBe('workspace')
  })

  it('falls back to "workspace" for empty inputs', () => {
    expect(
      getWorkspaceSeedName({
        explicitName: '',
        prompt: '',
        linkedIssueNumber: null,
        linkedPR: null
      })
    ).toBe('workspace')
  })
})
