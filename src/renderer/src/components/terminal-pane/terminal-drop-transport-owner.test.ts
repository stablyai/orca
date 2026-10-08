import { describe, expect, it, vi } from 'vitest'
import { captureTerminalDropTransportOwner } from './terminal-drop-transport-owner'

const mocks = vi.hoisted(() => ({
  state: {
    settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
    sshConnectionStates: new Map([['host-1', { connectionGeneration: 1 }]])
  }
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))

describe('terminal drop transport owner', () => {
  it('uses the receiving host rather than the focused runtime', () => {
    const owner = captureTerminalDropTransportOwner({ getExecutionHostId: () => 'local' })
    expect(owner?.executionHostId).toBe('local')
    expect(owner?.runtimeEnvironmentId).toBeNull()
    expect(captureTerminalDropTransportOwner({})).toBeNull()
  })

  it('captures and rechecks a runtime transport after settings change', () => {
    let environmentId = 'owner-runtime'
    const owner = captureTerminalDropTransportOwner({
      getExecutionHostId: () => 'local',
      getRuntimeEnvironmentId: () => environmentId
    })
    expect(owner?.executionHostId).toBe('local')
    expect(owner?.expectedExecutionHostId).toBe('local')
    expect(owner?.runtimeEnvironmentId).toBe('owner-runtime')
    mocks.state.settings.activeRuntimeEnvironmentId = 'unrelated-runtime'
    expect(() => owner?.assertCurrent()).not.toThrow()
    environmentId = 'replacement-runtime'
    expect(() => owner?.assertCurrent()).toThrow('Terminal upload host changed')
  })

  it('refuses an SSH attachment after the connection generation changes', () => {
    const owner = captureTerminalDropTransportOwner({ getExecutionHostId: () => 'ssh:host-1' })
    expect(owner?.expectedExecutionHostId).toBe('ssh:host-1')
    mocks.state.sshConnectionStates = new Map([['host-1', { connectionGeneration: 2 }]])
    expect(() => owner?.assertCurrent()).toThrow('Terminal upload host changed')
  })
})
