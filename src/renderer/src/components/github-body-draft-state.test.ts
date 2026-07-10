import { describe, expect, it } from 'vitest'
import { resolveGitHubBodyDraft, shouldSyncGitHubBodyDraft } from './github-body-draft-state'

describe('GitHub body draft state', () => {
  it('uses the latest body while not editing', () => {
    expect(resolveGitHubBodyDraft('old body', 'fresh body', false)).toBe('fresh body')
  })

  it('preserves a local draft while editing', () => {
    expect(resolveGitHubBodyDraft('local draft', 'fresh body', true)).toBe('local draft')
  })

  it('only schedules draft sync when not editing and stale', () => {
    expect(shouldSyncGitHubBodyDraft('old body', 'fresh body', false)).toBe(true)
    expect(shouldSyncGitHubBodyDraft('local draft', 'fresh body', true)).toBe(false)
    expect(shouldSyncGitHubBodyDraft('fresh body', 'fresh body', false)).toBe(false)
  })
})
