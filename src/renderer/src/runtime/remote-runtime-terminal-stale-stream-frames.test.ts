import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import {
  getRemoteRuntimeTerminalMultiplexer,
  resetRemoteRuntimeTerminalMultiplexersForTests,
  type RemoteRuntimeMultiplexedTerminal
} from './remote-runtime-terminal-multiplexer'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'

// Why: sendFrame gates on socket readiness alone, so a dropped stream handle reported success
// while the host discarded the frames for an unknown stream id.

type SubscribeCallbacks = {
  onResponse: (response: unknown) => void
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
  onError?: (error: { message: string }) => void
  onClose?: () => void
}

describe('remote terminal stale stream frames', () => {
  let sent: Uint8Array<ArrayBufferLike>[]

  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeTerminalMultiplexersForTests()
    replaceRuntimeEnvironmentRevisions([])
    sent = []

    const subscribe = vi.fn(async (_args: unknown, callbacks: SubscribeCallbacks) => {
      queueMicrotask(() => callbacks.onResponse({ ok: true, result: { type: 'ready' } }))
      return {
        unsubscribe: vi.fn(),
        sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => {
          sent.push(bytes)
        }
      }
    })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { subscribe } } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function subscribeStream(terminal: string): Promise<RemoteRuntimeMultiplexedTerminal> {
    const stream = await getRemoteRuntimeTerminalMultiplexer('env-1').subscribeTerminal({
      terminal,
      client: { id: 'desktop-1', type: 'desktop' },
      callbacks: { onData: () => {}, onSnapshot: () => {} }
    })
    await Promise.resolve()
    return stream
  }

  function inputTextOnWire(): string {
    return sent
      .map((bytes) => decodeTerminalStreamFrame(bytes))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.Input)
      .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
      .join('')
  }

  function opcodeCount(opcode: TerminalStreamOpcode): number {
    return sent.filter((bytes) => decodeTerminalStreamFrame(bytes)?.opcode === opcode).length
  }

  it('refuses input and viewport frames from a closed stream while a sibling keeps the socket live', async () => {
    const parked = await subscribeStream('terminal-1')
    // A sibling stream keeps the multiplexer connected, so `ready` stays true after the close.
    await subscribeStream('terminal-2')

    parked.close()
    sent = []

    expect(parked.sendInput('never-delivered\r')).toBe(false)
    expect(parked.claimViewport(80, 24)).toBe(false)
    expect(parked.resize(80, 24)).toBe(false)

    expect(inputTextOnWire()).toBe('')
    expect(opcodeCount(TerminalStreamOpcode.ClaimViewport)).toBe(0)
    expect(opcodeCount(TerminalStreamOpcode.Resize)).toBe(0)
  })
})
