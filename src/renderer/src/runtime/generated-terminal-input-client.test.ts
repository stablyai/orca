import { beforeEach, expect, it, vi } from 'vitest'

const callRuntimeRpc = vi.fn()
const capabilities = vi.hoisted(() => ({ unsupported: new Set<string>() }))
// The status every capability decision of a request reads: the cached entry's, less what a case
// marks unsupported. A call is handed over, as the real client does, just before it is sent.
vi.mock('./runtime-rpc-client', async () => {
  const cache = await import('./runtime-compatibility-cache')
  const caps = await import('../../../shared/terminal/runtime-policy/terminal-runtime-capabilities')
  const generated = await import('../../../shared/generated-terminal-input')
  return {
    callRuntimeRpc: (...args: [unknown, string, unknown, { beforeSend?: () => void }?]) => {
      args[3]?.beforeSend?.()
      return callRuntimeRpc(...args)
    },
    forgetMissingRuntimeCapability: () => {},
    selectRuntimeEnvironmentStatus: async (environmentId: string) => {
      const entry =
        cache.runtimeCompatibilityChecks.get(environmentId) ?? cache.compatibilityEntry()
      const capabilities_ = [
        generated.GENERATED_INPUT_RUNTIME_CAPABILITY,
        caps.GENERATED_INPUT_REGISTER_RUNTIME_CAPABILITY,
        caps.GENERATED_INPUT_FENCED_SEND_RUNTIME_CAPABILITY
      ].filter((capability) => !capabilities.unsupported.has(capability))
      return { entry, status: { ...entry.status, capabilities: capabilities_ } }
    }
  }
})
vi.mock('./runtime-terminal-stream', () => ({ getRemoteRuntimePtyOwner: () => null }))

const { sendGeneratedTerminalInput, sendGeneratedTerminalInputToHandle } =
  await import('./generated-terminal-input-client')
const { RuntimeRpcCallError } = await import('./runtime-rpc-result')
const { compatibilityEntry, rememberRuntimeEnvironmentCompatibility, runtimeCompatibilityChecks } =
  await import('./runtime-compatibility-cache')
const {
  GENERATED_INPUT_FENCED_SEND_RUNTIME_CAPABILITY,
  GENERATED_INPUT_REGISTER_RUNTIME_CAPABILITY
} = await import('../../../shared/terminal/runtime-policy/terminal-runtime-capabilities')

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

    // XR13: cancelled before it was handed to IPC, the request was never issued: not sent.
    subscribe.mockClear()
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(
      sendGeneratedTerminalInput('pty-1', { text: 'go', submit: false }, cancelled.signal)
    ).resolves.toBe('not-sent')
    expect(subscribe).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllGlobals()
  }
})

// XR1/T1/T2: a retained send to a host that enforces it names the runtime whose support the
// ordinary compatibility check verified, with no status call or runtime expectation of its own; a
// host without that contract gets the plain request it always did. A refusal by another runtime
// is a definite "not sent", is never resent, and makes the next request learn the runtime afresh.
it('qualifies a retained send by the verified runtime, never resending a refused one', async () => {
  capabilities.unsupported.clear()
  const target = { kind: 'environment' as const, environmentId: 'env' }
  rememberRuntimeEnvironmentCompatibility(
    'env',
    compatibilityEntry({
      runtimeId: 'h1',
      capabilities: [
        GENERATED_INPUT_REGISTER_RUNTIME_CAPABILITY,
        GENERATED_INPUT_FENCED_SEND_RUNTIME_CAPABILITY
      ]
    } as never)
  )
  const request = { text: 'go', submit: true, retainNotice: true, operationId: 'op' }
  callRuntimeRpc.mockResolvedValueOnce({ delivery: { outcome: 'delivered' } })
  await expect(sendGeneratedTerminalInputToHandle(target, 'terminal', request)).resolves.toBe(
    'delivered'
  )
  expect(callRuntimeRpc).toHaveBeenCalledExactlyOnceWith(
    target,
    'terminal.sendGeneratedInput',
    expect.objectContaining({
      terminal: { handle: 'terminal', expectedRuntimeId: 'h1' },
      operationId: 'op'
    }),
    expect.objectContaining({ timeoutMs: expect.any(Number), generatedInputOperationId: 'op' })
  )
  // T2/XR1: the receiver fences the runtime; main's registry runtime never gates this send.
  const [, , , options] = callRuntimeRpc.mock.calls[0]
  expect(options).not.toHaveProperty('expectedEnvironmentRuntimeId')
  expect(options).not.toHaveProperty('paramsForStatus')

  callRuntimeRpc.mockReset()
  callRuntimeRpc.mockResolvedValueOnce({ refused: 'runtime-changed' })
  await expect(sendGeneratedTerminalInputToHandle(target, 'terminal', request)).resolves.toBe(
    'not-sent'
  )
  expect(callRuntimeRpc).toHaveBeenCalledOnce()
  expect(runtimeCompatibilityChecks.has('env')).toBe(false)

  callRuntimeRpc.mockReset()
  capabilities.unsupported.add(GENERATED_INPUT_FENCED_SEND_RUNTIME_CAPABILITY)
  callRuntimeRpc.mockResolvedValueOnce({ delivery: { outcome: 'not-sent' } })
  await sendGeneratedTerminalInputToHandle(target, 'terminal', request)
  const [, , plain] = callRuntimeRpc.mock.calls[0]
  expect(plain).toMatchObject({ terminal: 'terminal', text: 'go' })
  expect(plain).not.toHaveProperty('operationId')
  expect(plain).not.toHaveProperty('retainNotice')
})

// T1, main's refusal branch: a send main refused because the pairing or runtime changed reads as
// possibly sent to this caller (main itself proves it unsent), is never resent, and clears only
// that environment's verified status, so the next independent request learns it afresh.
it('clears only the refusing environment after runtime_environment_changed, sending once', async () => {
  capabilities.unsupported.clear()
  const status = (runtimeId: string) =>
    compatibilityEntry({
      runtimeId,
      capabilities: [
        GENERATED_INPUT_REGISTER_RUNTIME_CAPABILITY,
        GENERATED_INPUT_FENCED_SEND_RUNTIME_CAPABILITY
      ]
    } as never)
  rememberRuntimeEnvironmentCompatibility('env', status('h1'))
  rememberRuntimeEnvironmentCompatibility('other', status('o1'))
  callRuntimeRpc.mockReset()
  callRuntimeRpc.mockRejectedValueOnce(
    new RuntimeRpcCallError({
      id: 'terminal.sendGeneratedInput',
      ok: false,
      error: { code: 'runtime_environment_changed', message: 'changed' },
      _meta: { runtimeId: 'h2' }
    })
  )
  const target = { kind: 'environment' as const, environmentId: 'env' }
  await expect(
    sendGeneratedTerminalInputToHandle(target, 'terminal', {
      text: 'go',
      submit: true,
      retainNotice: true,
      operationId: 'op'
    })
  ).resolves.toBe('unconfirmed')
  expect(callRuntimeRpc).toHaveBeenCalledOnce()
  expect(runtimeCompatibilityChecks.has('env')).toBe(false)
  expect(runtimeCompatibilityChecks.get('other')?.status?.runtimeId).toBe('o1')
})
