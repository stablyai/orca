import { describe, expect, it } from 'vitest'
import { buildRemovedSshTargetCleanupPatch } from './ssh-target-cleanup'
import { useAppStore } from '@/store'

describe('buildRemovedSshTargetCleanupPatch, pending deferred worktree paths', () => {
  it('drops the removed target entry even when it is the only stale field', () => {
    const state = {
      ...useAppStore.getState(),
      pendingDeferredWorktreePathsByTargetId: {
        'target-x': ['/home/user/project'],
        'target-y': ['/home/user/other']
      }
    }
    const patch = buildRemovedSshTargetCleanupPatch(state, 'target-x')
    expect(patch).not.toBeNull()
    expect(patch?.pendingDeferredWorktreePathsByTargetId).toEqual({
      'target-y': ['/home/user/other']
    })
  })

  it('returns null when the target has no state anywhere', () => {
    const state = {
      ...useAppStore.getState(),
      pendingDeferredWorktreePathsByTargetId: {}
    }
    expect(buildRemovedSshTargetCleanupPatch(state, 'target-x')).toBeNull()
  })
})
