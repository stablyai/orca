import { describe, expect, it } from 'vitest'
import { canonicalWorktreeIdentity, type WorktreeIdentityRef } from './identity'

describe('canonical worktree identity', () => {
  const local: WorktreeIdentityRef = {
    worktreeId: 'repo-1::/workspace/feature',
    executionHostId: 'local',
    instanceId: '11111111-1111-4111-8111-111111111111'
  }
  const remote: WorktreeIdentityRef = {
    ...local,
    executionHostId: 'ssh:build-box'
  }

  it('separates same locator and instance across execution hosts', () => {
    expect(canonicalWorktreeIdentity(local)).not.toBe(canonicalWorktreeIdentity(remote))
  })

  it('is stable when only the path locator changes', () => {
    expect(
      canonicalWorktreeIdentity({ ...local, worktreeId: 'repo-1::/workspace/renamed-feature' })
    ).toBe(canonicalWorktreeIdentity(local))
  })

  it('does not use the display name as identity input', () => {
    expect(canonicalWorktreeIdentity(local)).toBe(canonicalWorktreeIdentity({ ...local }))
  })
})
