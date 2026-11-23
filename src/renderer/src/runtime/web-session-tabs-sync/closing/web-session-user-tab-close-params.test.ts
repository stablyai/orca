import { describe, expect, it, vi } from 'vitest'
import { SESSION_TAB_CLOSE_TERMINALS_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/protocol/session-tabs-runtime-capabilities'

const mockSupportsCapability = vi.fn()

vi.mock('../../rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: (...args: unknown[]) => mockSupportsCapability(...args)
}))

import { userTabCloseParams } from './web-session-user-tab-close-params'

describe('userTabCloseParams conditional terminal approval boundary', () => {
  it('preserves an empty terminal approval through the capability gate and refuses on older hosts', async () => {
    mockSupportsCapability.mockReset()
    mockSupportsCapability.mockResolvedValue(false)

    const oldHost = await userTabCloseParams('env-old', { reason: 'user', terminals: [] })
    expect(mockSupportsCapability).toHaveBeenCalledWith(
      'env-old',
      SESSION_TAB_CLOSE_TERMINALS_RUNTIME_CAPABILITY
    )
    expect(oldHost.approvalUnhonored).toBe(true)
    expect(oldHost.params.terminals).toBeUndefined()

    mockSupportsCapability.mockResolvedValue(true)
    const newHost = await userTabCloseParams('env-new', { reason: 'user', terminals: [] })
    expect(newHost.approvalUnhonored).toBe(false)
    expect(newHost.params.terminals).toEqual([])
  })

  it('propagates transient capability probe failures so offline closes can be held for replay', async () => {
    mockSupportsCapability.mockReset()
    mockSupportsCapability.mockRejectedValue(new Error('remote_runtime_timeout'))

    await expect(
      userTabCloseParams('env-offline', { reason: 'user', terminals: ['term_1'] })
    ).rejects.toThrow('remote_runtime_timeout')
  })

  it('leaves non-terminal closes without a terminals list unaffected on older hosts', async () => {
    mockSupportsCapability.mockReset()
    mockSupportsCapability.mockResolvedValue(false)

    const nonTerminal = await userTabCloseParams('env-old', { reason: 'user' })
    expect(nonTerminal.approvalUnhonored).toBe(false)
    expect(nonTerminal.params).toEqual({ reason: 'user' })
    expect(mockSupportsCapability).not.toHaveBeenCalled()
  })
})
