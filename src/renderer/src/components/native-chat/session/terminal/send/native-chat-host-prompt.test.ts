import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sendNativeChatHostPrompt } from './native-chat-host-prompt'
import {
  enqueueNativeChatPtySend,
  resetNativeChatPtySendQueuesForTests
} from './native-chat-pty-send-queue'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  capabilities: vi.fn(),
  record: vi.fn()
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.call }))
vi.mock('@/runtime/hosted-terminals/identity/remote-runtime-pty-owner', () => ({
  getRemoteRuntimePtyOwner: () => null
}))
vi.mock('@/runtime/hosted-terminals/input/runtime-terminal-input-recording', () => ({
  recordRuntimeTerminalInputForPtyId: mocks.record
}))

function send(
  text: string,
  onLegacy: Parameters<typeof sendNativeChatHostPrompt>[0]['onLegacy'] = vi.fn()
) {
  return sendNativeChatHostPrompt({
    ptyId: 'pty',
    paneKey: 'pane',
    prompt: { agent: 'claude', text },
    onLegacy,
    onEvidenceMode: () => {}
  })
}

beforeEach(() => {
  mocks.call.mockReset()
  mocks.capabilities.mockResolvedValue(['terminal.chat-prompt-expiry.v1'])
  vi.stubGlobal('window', {
    api: {
      runtime: {
        getStatus: async () => ({
          runtimeId: 'main',
          elapsedClockMs: 100000 + Math.floor(performance.now()),
          capabilities: await mocks.capabilities()
        })
      }
    }
  })
})
afterEach(() => {
  resetNativeChatPtySendQueuesForTests()
  vi.unstubAllGlobals()
})

it('detaches a canceled observer without allowing the next send to overtake its in-flight request', async () => {
  const started = Promise.withResolvers<void>()
  const response = Promise.withResolvers<unknown>()
  const texts: string[] = []
  mocks.call.mockImplementation(async (_target, method, packet) => {
    if (method === 'terminal.resolvePane') {
      return { terminal: { ptyId: 'pty', handle: 'terminal', incarnationId: 'process' } }
    }
    texts.push(packet.chatPrompt.text)
    if (packet.chatPrompt.text === 'first') {
      started.resolve()
      return response.promise
    }
    return { send: { accepted: true, writeSettlement: { outcome: 'accepted' } } }
  })
  const first = send('first')
  await started.promise
  first.cancel()
  await expect(first.outcome).resolves.toBe('uncertain')
  const second = send('second')
  await Promise.resolve()
  expect(texts).toEqual(['first'])
  response.resolve({ send: { accepted: true, writeSettlement: { outcome: 'accepted' } } })
  await expect(second.outcome).resolves.toBe('submitted')
  expect(texts).toEqual(['first', 'second'])
})

it('uses the shipped sender on a capability-less host without dispatching the new packet', async () => {
  mocks.capabilities.mockResolvedValue([])
  const legacy = vi.fn(() => ({
    cancel: () => {},
    settleAfterMs: 100,
    outcome: Promise.resolve('submitted' as const)
  }))
  const sent = send('old host', legacy)
  await expect(sent.outcome).resolves.toBe('submitted')
  expect(legacy).toHaveBeenCalledOnce()
  expect(mocks.call).not.toHaveBeenCalled()
})

it('does not confirm a send whose host response has no write settlement', async () => {
  mocks.call.mockImplementation(async (_target, method) =>
    method === 'terminal.resolvePane'
      ? { terminal: { ptyId: 'pty', handle: 'terminal', incarnationId: 'process' } }
      : { send: { accepted: true } }
  )
  await expect(send('body').outcome).resolves.toBe('uncertain')
})

it('orders host Chat, a legacy composer command and another host Chat in one PTY', async () => {
  const response = Promise.withResolvers<unknown>()
  const started = Promise.withResolvers<void>()
  const writes: string[] = []
  mocks.call.mockImplementation(async (_target, method, packet) => {
    if (method === 'terminal.resolvePane') {
      return { terminal: { ptyId: 'pty', handle: 'terminal', incarnationId: 'process' } }
    }
    writes.push(packet.chatPrompt.text)
    if (packet.chatPrompt.text === 'first') {
      started.resolve()
      return response.promise
    }
    return { send: { accepted: true, writeSettlement: { outcome: 'accepted' } } }
  })
  const first = send('first')
  await started.promise
  first.cancel()
  const commandDone = Promise.withResolvers<void>()
  const command = enqueueNativeChatPtySend('pty', 1, ({ markSubmitted }) => {
    writes.push('/compact')
    void commandDone.promise.then(() => markSubmitted())
  })
  const second = send('second')
  await Promise.resolve()
  expect(writes).toEqual(['first'])
  response.resolve({ send: { accepted: true, writeSettlement: { outcome: 'accepted' } } })
  await first.settled
  await vi.waitFor(() => expect(writes).toEqual(['first', '/compact']))
  commandDone.resolve()
  await command.settled
  await expect(second.outcome).resolves.toBe('submitted')
  expect(writes).toEqual(['first', '/compact', 'second'])
})

it('runs old-host fallback inside its reserved slot before a following composer command', async () => {
  mocks.capabilities.mockResolvedValue([])
  const writes: string[] = []
  const first = send('first', (dispatchScope) =>
    enqueueNativeChatPtySend(
      'pty',
      0,
      () => {
        writes.push('first')
      },
      { dispatchScope }
    )
  )
  const command = enqueueNativeChatPtySend('pty', 0, () => {
    writes.push('/compact')
  })
  await expect(first.outcome).resolves.toBe('submitted')
  await command.settled
  expect(writes).toEqual(['first', '/compact'])
})

it('keeps final dispatch refusal separate from an observer detached after handoff', async () => {
  const started = Promise.withResolvers<void>()
  const response = Promise.withResolvers<unknown>()
  mocks.call.mockImplementation(async (_target, method) => {
    if (method === 'terminal.resolvePane') {
      return { terminal: { ptyId: 'pty', handle: 'terminal' } }
    }
    started.resolve()
    return response.promise
  })
  const handle = send('repeat ')
  await started.promise
  handle.cancel()
  await expect(handle.outcome).resolves.toBe('uncertain')
  response.resolve({
    send: {
      accepted: false,
      writeSettlement: { outcome: 'refused', reason: 'provider_refused_write' }
    }
  })
  await expect(handle.dispatchOutcome).resolves.toBe('not-submitted')
})

it('finishes an unresolved local dispatch at its finite expiry even when IPC never replies', async () => {
  vi.useFakeTimers()
  try {
    const started = Promise.withResolvers<void>()
    mocks.call.mockImplementation(async (_target, method) => {
      if (method === 'terminal.resolvePane') {
        return { terminal: { ptyId: 'pty', handle: 'terminal' } }
      }
      started.resolve()
      return new Promise(() => {})
    })
    const handle = send('never replies')
    await started.promise
    await vi.advanceTimersByTimeAsync(65002)
    await expect(handle.dispatchOutcome).resolves.toBe('uncertain')
  } finally {
    vi.useRealTimers()
  }
})

it('holds the physical barrier after an ambiguous transport failure until the original expiry', async () => {
  vi.useFakeTimers()
  try {
    const started = Promise.withResolvers<void>()
    mocks.call.mockImplementation(async (_target, method) => {
      if (method === 'terminal.resolvePane') {
        return { terminal: { ptyId: 'pty', handle: 'terminal' } }
      }
      started.resolve()
      throw new Error('connection lost after possible dispatch')
    })
    const first = send('first')
    await started.promise
    await expect(first.outcome).resolves.toBe('uncertain')
    const writes: string[] = []
    const legacy = enqueueNativeChatPtySend('pty', 0, () => writes.push('legacy'))
    await vi.advanceTimersByTimeAsync(64000)
    expect(writes).toEqual([])
    await vi.advanceTimersByTimeAsync(1002)
    await legacy.settled
    expect(writes).toEqual(['legacy'])
    await expect(first.dispatchOutcome).resolves.toBe('uncertain')
  } finally {
    vi.useRealTimers()
  }
})

it('does not let an expired small follower release a live large predecessor to legacy input', async () => {
  vi.useFakeTimers()
  try {
    const response = Promise.withResolvers<unknown>()
    const started = Promise.withResolvers<void>()
    const writes: string[] = []
    mocks.call.mockImplementation(async (_target, method) => {
      if (method === 'terminal.resolvePane') {
        return { terminal: { ptyId: 'pty', handle: 'terminal' } }
      }
      writes.push('large')
      started.resolve()
      return response.promise
    })
    const first = send('x'.repeat(2000000))
    await started.promise
    await vi.advanceTimersByTimeAsync(1000)
    const second = send('small')
    await vi.advanceTimersByTimeAsync(65002)
    await expect(second.dispatchOutcome).resolves.toBe('not-submitted')
    const legacy = enqueueNativeChatPtySend('pty', 0, () => writes.push('legacy'))
    await vi.advanceTimersByTimeAsync(12998)
    expect(writes).toEqual(['large'])
    response.resolve({ send: { accepted: true, writeSettlement: { outcome: 'accepted' } } })
    await legacy.settled
    await expect(first.dispatchOutcome).resolves.toBe('submitted')
    expect(writes).toEqual(['large', 'legacy'])
  } finally {
    vi.useRealTimers()
  }
})

it('selects successful legacy input only on a same-socket unsupported result before mutation', async () => {
  mocks.call.mockImplementation(async (_target, method) =>
    method === 'terminal.resolvePane'
      ? { terminal: { ptyId: 'pty', handle: 'terminal' } }
      : { send: { accepted: false, bytesWritten: 0, chatPromptNotDispatched: 'unsupported' } }
  )
  const legacy = vi.fn(() => ({
    cancel: () => {},
    settleAfterMs: 0,
    outcome: Promise.resolve('submitted' as const)
  }))
  await expect(send('old runtime', legacy).dispatchOutcome).resolves.toBe('submitted')
  expect(legacy).toHaveBeenCalledOnce()
})
