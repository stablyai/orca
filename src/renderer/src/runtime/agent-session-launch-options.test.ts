import { beforeEach, expect, it, vi } from 'vitest'
import { createAgentSessionLaunchOptions } from './agent-session-launch-options'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'

vi.mock('./runtime-rpc-client', () => ({ runtimeEnvironmentSupportsCapability: vi.fn() }))
const probe = vi.mocked(runtimeEnvironmentSupportsCapability)
beforeEach(() => {
  probe.mockReset()
})

const ACCOUNT = { claudeAccountId: 'acct-1' }

it('keeps the first negotiated payload for a replay after the host upgrades', async () => {
  probe.mockResolvedValueOnce(false).mockResolvedValue(true)
  const resolve = createAgentSessionLaunchOptions(undefined)
  expect(await resolve('env-1', ACCOUNT)).toEqual({})
  expect(await resolve('env-1', ACCOUNT)).toEqual({})
  expect(probe).toHaveBeenCalledExactlyOnceWith('env-1', 'agent-session.claude-account.v1')
})

it('sends the account to a capable host and never probes for a launch without one', async () => {
  probe.mockResolvedValue(true)
  const resolve = createAgentSessionLaunchOptions(undefined)
  expect(await resolve('env-1', undefined)).toEqual({})
  expect(probe).not.toHaveBeenCalled()
  expect(await resolve('env-1', ACCOUNT)).toEqual(ACCOUNT)
})

it('omits the account when the probe fails, but propagates a compat block', async () => {
  probe.mockRejectedValueOnce(new Error('disconnected'))
  expect(await createAgentSessionLaunchOptions(undefined)('env-1', ACCOUNT)).toEqual({})
  const block = Object.assign(new Error('update required'), { code: 'runtime_compat_block' })
  probe.mockRejectedValue(block)
  await expect(createAgentSessionLaunchOptions(undefined)('env-1', ACCOUNT)).rejects.toBe(block)
})
