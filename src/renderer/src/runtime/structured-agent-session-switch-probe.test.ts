import { expect, it, vi } from 'vitest'
import type * as RuntimeRpcClient from './runtime-rpc-client'
import { supportsInPlaceSwitch } from './structured-agent-session-client'

vi.mock('./runtime-rpc-client', async (original) => ({
  ...(await original<typeof RuntimeRpcClient>()),
  // The connection dropped while the host's capabilities were re-read.
  runtimeEnvironmentSupportsCapability: vi.fn(async () => {
    throw new Error('Remote Orca runtime is not connected.')
  })
}))

const paired = { kind: 'environment' as const, environmentId: 'paired' }

it('lets the switch tell a host it could not ask from one without the switch', async () => {
  await expect(supportsInPlaceSwitch(paired, 'codex', true)).rejects.toThrow('not connected')
  // Surfaces that only choose what to offer still read "not offered".
  await expect(supportsInPlaceSwitch(paired, 'codex')).resolves.toBe(false)
})
