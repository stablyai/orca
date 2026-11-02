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

// J8: a local takeover cancels the host's request through the subscription transport's unsubscribe;
// the lost answer reads as unconfirmed and the text is never sent again.
it('cancels a local request by unsubscribing, and reads its lost answer as unconfirmed', async () => {
  const unsubscribe = vi.fn()
  const subscribe = vi.fn(async () => ({ unsubscribe }))
  vi.stubGlobal('window', { api: { runtime: { subscribe } } })
  try {
    const takeover = new AbortController()
    const sent = sendGeneratedTerminalInput('pty-1', { text: 'go', submit: false }, takeover.signal)
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce())
    expect(subscribe).toHaveBeenCalledWith(
      {
        method: 'terminal.sendGeneratedInput',
        params: expect.objectContaining({ ptyId: 'pty-1', text: 'go' })
      },
      expect.any(Function)
    )
    takeover.abort()
    await expect(sent).resolves.toBe('unconfirmed')
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllGlobals()
  }
})
