import { describe, expect, it } from 'vitest'
import type { DetectedWorktreeListResult } from '../../../../../../shared/worktree/types'
import { applyDetectedWorktreeUpdates } from './detected-worktree-meta'

describe('applyDetectedWorktreeUpdates display-name provenance', () => {
  it('projects pinning changes into detected rows', () => {
    const detected = {
      id: 'repo-1::/workspace/feature',
      displayName: 'feature',
      displayNameMode: 'automatic',
      repoId: 'repo-1',
      branch: 'refs/heads/feature'
    }
    const state = {
      'repo-1': {
        repoId: 'repo-1',
        authoritative: true,
        source: 'git',
        worktrees: [detected]
      }
    } as unknown as Record<string, DetectedWorktreeListResult>

    const fixed = applyDetectedWorktreeUpdates(state, detected.id, {
      displayName: 'Agent workspace',
      displayNameIsPinned: true
    })
    expect(fixed['repo-1']?.worktrees[0]).toMatchObject({
      displayName: 'Agent workspace',
      displayNameMode: 'fixed'
    })

    const automatic = applyDetectedWorktreeUpdates(state, detected.id, {
      displayName: '',
      displayNameIsPinned: false
    })
    expect(automatic['repo-1']?.worktrees[0]).toMatchObject({
      displayName: 'feature',
      displayNameMode: 'automatic'
    })
  })

  it('keeps text until the host resolves a detached fallback', () => {
    const detached = {
      id: 'repo-1::/workspace/feature',
      displayName: 'Agent workspace',
      displayNameMode: 'fixed' as const,
      repoId: 'repo-1',
      branch: ''
    }
    const detachedState = {
      'repo-1': {
        repoId: 'repo-1',
        authoritative: true,
        source: 'git',
        worktrees: [detached]
      }
    } as unknown as Record<string, DetectedWorktreeListResult>

    const automatic = applyDetectedWorktreeUpdates(detachedState, detached.id, {
      displayName: '',
      displayNameIsPinned: false
    })

    expect(automatic['repo-1']?.worktrees[0]).toMatchObject({
      displayName: 'Agent workspace',
      displayNameMode: 'automatic'
    })
  })
})
