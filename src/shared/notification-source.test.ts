import { describe, expect, it } from 'vitest'
import { notificationExecutionHostForOwner } from './notification-source'
import { toRuntimeExecutionHostId } from './execution-host'

describe('notification execution host', () => {
  it('names the WSL host that runs the work, so a tapped push opens it through the desktop', () => {
    const hostId = toRuntimeExecutionHostId('wsl:ubuntu')
    expect(
      notificationExecutionHostForOwner({ executionHostId: hostId, runtimeEnvironmentId: null })
    ).toBe(hostId)
    expect(hostId).toBe('runtime:wsl%3Aubuntu')
  })

  it("sends none for work this desktop runs itself, so the phone opens the desktop's own", () => {
    expect(
      notificationExecutionHostForOwner({ executionHostId: 'local', runtimeEnvironmentId: null })
    ).toBeUndefined()
    expect(notificationExecutionHostForOwner(null)).toBeUndefined()
  })
})
