import { describe, expect, it, vi } from 'vitest'
import {
  DIRECT_SSH_RECONNECT_SESSION_ROUTE_KEY,
  isDirectSshReconnectCoordinatorRoutingEnabled,
  resolveDirectSshReconnectCoordinatorRouting
} from './direct-ssh-reconnect-rollout'

describe('direct SSH reconnect rollout', () => {
  it('defaults coordinator routing on', () => {
    expect(resolveDirectSshReconnectCoordinatorRouting({})).toBe(true)
    expect(resolveDirectSshReconnectCoordinatorRouting({ buildValue: 'true' })).toBe(true)
  })

  it('supports build and session disable routes without session re-enablement', () => {
    expect(
      resolveDirectSshReconnectCoordinatorRouting({
        buildValue: 'false',
        sessionValue: 'true'
      })
    ).toBe(false)
    expect(
      resolveDirectSshReconnectCoordinatorRouting({
        buildValue: 'true',
        sessionValue: 'false'
      })
    ).toBe(false)
  })

  it('reads the current session route and fails open when storage is unavailable', () => {
    const getItem = vi.fn(() => 'false')
    vi.stubGlobal('sessionStorage', { getItem })

    expect(isDirectSshReconnectCoordinatorRoutingEnabled()).toBe(false)
    expect(getItem).toHaveBeenCalledWith(DIRECT_SSH_RECONNECT_SESSION_ROUTE_KEY)

    getItem.mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(isDirectSshReconnectCoordinatorRoutingEnabled()).toBe(true)
    vi.unstubAllGlobals()
  })
})
