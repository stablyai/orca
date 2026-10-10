import { describe, expect, it } from 'vitest'
import { getRepoOwnerWorktreeVisibilityDefaults } from './worktree-visibility-defaults-by-host'

describe('getRepoOwnerWorktreeVisibilityDefaults', () => {
  it('resolves defaults from each repository owner', () => {
    const settings = { worktreeVisibilityDefaults: { external: 'hide' as const } }
    const defaultsByHost = {
      local: { external: 'hide' as const },
      'runtime:show-host': { external: 'show' as const },
      'runtime:legacy-host': null
    }

    expect(
      getRepoOwnerWorktreeVisibilityDefaults(
        { executionHostId: 'runtime:show-host' },
        settings,
        defaultsByHost
      )
    ).toEqual({ external: 'show' })
    expect(
      getRepoOwnerWorktreeVisibilityDefaults({ connectionId: 'ssh-box' }, settings, defaultsByHost)
    ).toEqual({ external: 'hide' })
    expect(
      getRepoOwnerWorktreeVisibilityDefaults(
        { executionHostId: 'runtime:legacy-host' },
        settings,
        defaultsByHost
      )
    ).toBeUndefined()
  })
})
