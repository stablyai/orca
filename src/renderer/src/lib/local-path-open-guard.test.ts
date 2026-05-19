import { describe, expect, it } from 'vitest'
import { isLocalPathOpenBlocked } from './local-path-open-guard'

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
