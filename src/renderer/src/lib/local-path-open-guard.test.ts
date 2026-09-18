import { describe, expect, it } from 'vitest'
import {
  isLocalPathOpenBlocked,
  isLocalPathOpenBlockedForRuntimeOwner
} from './local-path-open-guard'

describe('isLocalPathOpenBlocked', () => {
  it('allows local paths without a runtime or SSH connection', () => {
    expect(isLocalPathOpenBlocked({ activeRuntimeEnvironmentId: null })).toBe(false)
  })

  it('blocks paths while a runtime environment is active', () => {
    expect(isLocalPathOpenBlocked({ activeRuntimeEnvironmentId: 'env-1' })).toBe(true)
  })

  it('blocks SSH-backed paths', () => {
    expect(
      isLocalPathOpenBlocked({ activeRuntimeEnvironmentId: null }, { connectionId: 'ssh-1' })
    ).toBe(true)
  })
})

describe('isLocalPathOpenBlockedForRuntimeOwner', () => {
  it('does not block a local worktree while a remote runtime is globally active', () => {
    expect(
      isLocalPathOpenBlockedForRuntimeOwner({ activeRuntimeEnvironmentId: 'env-1' }, null, {
        connectionId: null
      })
    ).toBe(false)
  })

  it('blocks a remote-owned worktree even when the global runtime is local', () => {
    expect(
      isLocalPathOpenBlockedForRuntimeOwner({ activeRuntimeEnvironmentId: null }, 'env-1', {
        connectionId: null
      })
    ).toBe(true)
  })

  it('blocks SSH-backed paths even when the worktree runtime owner is local', () => {
    expect(
      isLocalPathOpenBlockedForRuntimeOwner({ activeRuntimeEnvironmentId: 'env-1' }, null, {
        connectionId: 'ssh-1'
      })
    ).toBe(true)
  })
})
