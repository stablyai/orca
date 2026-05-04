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

  it('does not leave internal ".." in the slug (git refuses such branches)', () => {
    // Why: the original composer bug — a prompt containing "../../" in
    // relative path references slugified to a name with internal `..`,
    // which git rejects with "is not a valid branch name".
    const seed = getWorkspaceSeedName({
      explicitName: '',
      prompt: 'For ../../ the sibling worktree from another repo',
      linkedIssueNumber: null,
      linkedPR: null
    })
    expect(seed).not.toMatch(/\.{2,}/)
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

  it('uses the fallback name when no other seed source is available', () => {
    expect(
      getWorkspaceSeedName({
        explicitName: '',
        prompt: '',
        linkedIssueNumber: null,
        linkedPR: null,
        fallbackName: 'Nautilus'
      })
    ).toBe('Nautilus')
  })

  it('prefers an explicit name over the fallback name', () => {
    expect(
      getWorkspaceSeedName({
        explicitName: 'my-workspace',
        prompt: '',
        linkedIssueNumber: null,
        linkedPR: null,
        fallbackName: 'Nautilus'
      })
    ).toBe('my-workspace')
  })
})
