import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson
} from '../../../../../shared/terminal/stream/terminal-stream-protocol'
import {
  getRemoteRuntimeTerminalMultiplexer,
  resetRemoteRuntimeTerminalMultiplexersForTests
} from './registry/remote-runtime-terminal-multiplexer-registry'
import { replaceRuntimeEnvironmentRevisions } from '../../rpc/environment-revisions/runtime-environment-revision'
import { stubRuntimeEnvironmentBridge } from '../../rpc/testing/runtime-environment-bridge-fixture'

type SubscribeCallbacks = { onResponse: (response: unknown) => void }

// Why: hosts that predate opcode 20 reject it, so the client may send it only after the capability echo.
describe('remote terminal output cadence negotiation', () => {
  let hostCapabilities: Record<string, 1>
  let cadenceFrames: unknown[]

  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeTerminalMultiplexersForTests()
    replaceRuntimeEnvironmentRevisions([])
    cadenceFrames = []
    const subscribe = vi.fn(async (_args: unknown, next: SubscribeCallbacks) => {
      queueMicrotask(() => next.onResponse({ ok: true, result: { type: 'ready' } }))
      return {
        unsubscribe: vi.fn(),
        sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => {
          const frame = decodeTerminalStreamFrame(bytes)
          if (frame?.opcode === TerminalStreamOpcode.Subscribe) {
            const payload = decodeTerminalStreamJson<{ streamId: number }>(frame.payload)
            next.onResponse({
              ok: true,
              result: {
                type: 'subscribed',
                streamId: payload?.streamId ?? 0,
                capabilities: hostCapabilities
              }
            })
          } else if (frame?.opcode === TerminalStreamOpcode.SetOutputCadence) {
            cadenceFrames.push(decodeTerminalStreamJson(frame.payload))
          }
        }
      }
    })
    stubRuntimeEnvironmentBridge({ subscribe })
  })

  async function subscribeAndBackground(): Promise<void> {
    const stream = await getRemoteRuntimeTerminalMultiplexer('env-1').subscribeTerminal({
      terminal: 'terminal-1',
      client: { id: 'desktop-1', type: 'desktop' },
      outputCadence: 'focused',
      callbacks: { onData: () => {}, onSnapshot: () => {} }
    })
    stream.setOutputCadence('background')
  }

  it('never sends a cadence frame to a host that did not echo the capability', async () => {
    hostCapabilities = { outputPause: 1 }
    await subscribeAndBackground()
    expect(cadenceFrames).toEqual([])
  })

  it('sends the cadence to a host that echoed the capability', async () => {
    hostCapabilities = { outputPause: 1, outputCadence: 1 }
    await subscribeAndBackground()
    expect(cadenceFrames).toEqual([{ cadence: 'background' }])
  })
})
