import { describe, expect, it } from 'vitest'
import { resolveNativeChatSkillDiscoveryCwd } from './use-native-chat-skills'

describe('resolveNativeChatSkillDiscoveryCwd', () => {
  it('returns the owning worktree path for a terminal tab', () => {
    expect(
      resolveNativeChatSkillDiscoveryCwd(
        {
          tabsByWorktree: { worktree: [{ id: 'tab-1' }] },
          worktreesByRepo: { repo: [{ id: 'worktree', path: '/repo/worktree' }] }
        },
        'tab-1'
      )
    ).toBe('/repo/worktree')
  })

  it('returns null when the tab has no known worktree owner', () => {
    expect(
      resolveNativeChatSkillDiscoveryCwd({ tabsByWorktree: {}, worktreesByRepo: {} }, 'tab-1')
    ).toBeNull()
  })
})
