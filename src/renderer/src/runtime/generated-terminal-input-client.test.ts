import { beforeEach, expect, it, vi } from 'vitest'

const callRuntimeRpc = vi.fn()
vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc,
  runtimeEnvironmentSupportsCapability: async () => true
}))
vi.mock('./runtime-terminal-stream', () => ({ getRemoteRuntimePtyOwner: () => null }))

const { sendGeneratedTerminalInput } = await import('./generated-terminal-input-client')

beforeEach(() => callRuntimeRpc.mockReset())

// A local terminal closed before the write is the host's own answer: a reused automation session
// starts afresh only on it, so it is never turned into "old host" or "maybe sent".
it("returns the local host's target-gone, and a lost answer as unconfirmed", async () => {
  callRuntimeRpc.mockResolvedValueOnce({ delivery: { outcome: 'target-gone' } })
  await expect(sendGeneratedTerminalInput('pty-1', { text: 'go', submit: true })).resolves.toBe(
    'target-gone'
  )
  callRuntimeRpc.mockRejectedValueOnce(new Error('socket closed'))
  await expect(sendGeneratedTerminalInput('pty-1', { text: 'go', submit: true })).resolves.toBe(
    'unconfirmed'
  )
  expect(callRuntimeRpc).toHaveBeenNthCalledWith(
    1,
    { kind: 'local' },
    'terminal.sendGeneratedInput',
    expect.objectContaining({ ptyId: 'pty-1', text: 'go' }),
    expect.anything()
  )
})
