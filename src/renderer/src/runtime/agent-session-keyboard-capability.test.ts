import { beforeEach, expect, it, vi } from 'vitest'
import { createAgentSessionKeyboardOptions } from './agent-session-keyboard-capability'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'

vi.mock('./runtime-rpc-client', () => ({ runtimeEnvironmentSupportsCapability: vi.fn() }))
const probe = vi.mocked(runtimeEnvironmentSupportsCapability)
beforeEach(() => {
  probe.mockReset()
})

it.each([true, false])(
  'negotiates once and freezes the payload across reconnects: %s',
  async (supported) => {
    probe.mockResolvedValueOnce(supported).mockResolvedValue(!supported)
    const resolve = createAgentSessionKeyboardOptions(true)
    const first = resolve('env-1')
    expect(resolve('env-1')).toBe(first)
    expect(await first).toEqual(supported ? { terminalKittyKeyboardProtocol: true } : {})
    expect(await resolve('env-1')).toEqual(await first)
    expect(probe).toHaveBeenCalledExactlyOnceWith('env-1', 'agent-session.keyboard.v1')
  }
)
it.each([undefined, false])(
  'does not probe or advertise disabled renderer support: %s',
  async (enabled) => {
    expect(await createAgentSessionKeyboardOptions(enabled)('env-1')).toEqual({})
    expect(probe).not.toHaveBeenCalled()
  }
)
it('keeps the legacy payload after an unavailable read-only capability probe', async () => {
  probe.mockRejectedValueOnce(new Error('disconnected')).mockResolvedValue(true)
  const resolve = createAgentSessionKeyboardOptions(true)
  expect(await resolve('env-1')).toEqual({})
  expect(await resolve('env-1')).toEqual({})
  expect(probe).toHaveBeenCalledOnce()
})

it('preserves an incompatible runtime refusal instead of degrading the launch', async () => {
  const error = Object.assign(new Error('update required'), { code: 'runtime_compat_block' })
  probe.mockRejectedValue(error)
  await expect(createAgentSessionKeyboardOptions(true)('env-1')).rejects.toBe(error)
})
