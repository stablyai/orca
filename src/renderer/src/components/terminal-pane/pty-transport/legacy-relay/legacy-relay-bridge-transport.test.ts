// @orca-isolated-worker: the module-level pane subscription captures this file's bridge.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LegacyRelayBridgedPane } from '../../../../../../shared/legacy-relay-bridge-contract'
import type { PtyTransport } from '../pty-transport-types'

const relayCopy = vi.hoisted(() => ({ message: vi.fn(() => 'unreachable in language A') }))
vi.mock('./legacy-relay-bridge-copy', () => ({
  legacyRelayBridgeUnreachableMessage: relayCopy.message
}))

const PTY = 'ssh:ssh-box@@pty-1'

const bridge = vi.hoisted(() => ({
  attach: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  detach: vi.fn(),
  close: vi.fn(async () => ({ status: 'requested' })),
  setOutputPaused: vi.fn(),
  listPanes: vi.fn(async (): Promise<LegacyRelayBridgedPane[]> => []),
  panes: new Set<(panes: LegacyRelayBridgedPane[]) => void>(),
  data: new Set<(event: { ptyId: string; data: string }) => void>(),
  replay: new Set<(event: { ptyId: string; replay: string }) => void>(),
  exit: new Set<(event: { ptyId: string; code: number }) => void>()
}))

vi.stubGlobal('window', {
  api: {
    legacyRelayBridge: {
      listPanes: bridge.listPanes,
      attach: bridge.attach,
      write: bridge.write,
      resize: bridge.resize,
      detach: bridge.detach,
      close: bridge.close,
      setOutputPaused: bridge.setOutputPaused,
      onPanes: (listener: (panes: LegacyRelayBridgedPane[]) => void) => {
        bridge.panes.add(listener)
        return () => bridge.panes.delete(listener)
      },
      onData: (listener: (event: { ptyId: string; data: string }) => void) => {
        bridge.data.add(listener)
        return () => bridge.data.delete(listener)
      },
      onReplay: (listener: (event: { ptyId: string; replay: string }) => void) => {
        bridge.replay.add(listener)
        return () => bridge.replay.delete(listener)
      },
      onExit: (listener: (event: { ptyId: string; code: number }) => void) => {
        bridge.exit.add(listener)
        return () => bridge.exit.delete(listener)
      }
    }
  }
})

const { createLegacyRelayBridgeTransport: createTransport } =
  await import('./legacy-relay-bridge-transport')
const created: PtyTransport[] = []
function createLegacyRelayBridgeTransport(ptyId: string, inner: PtyTransport): PtyTransport {
  const transport = createTransport(ptyId, inner)
  created.push(transport)
  return transport
}

function publishPanes(panes: LegacyRelayBridgedPane[]): void {
  bridge.panes.forEach((listener) => listener(panes))
}

function innerTransport(): PtyTransport {
  return {
    connect: vi.fn(async () => 'remote:env-1@@t-1'),
    attach: vi.fn(),
    disconnect: vi.fn(),
    sendInput: vi.fn(() => true),
    sendInputImmediate: vi.fn(() => true),
    resize: vi.fn(() => true),
    isConnected: vi.fn(() => true),
    getPtyId: vi.fn(() => 'remote:env-1@@t-1')
  }
}

function callbacks() {
  return {
    onConnect: vi.fn(),
    onData: vi.fn(),
    onReplayData: vi.fn(),
    onError: vi.fn(),
    onErrorCleared: vi.fn(),
    onExit: vi.fn()
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  relayCopy.message.mockReset().mockReturnValue('unreachable in language A')
  publishPanes([])
})

afterEach(async () => {
  await Promise.all(created.splice(0).map((transport) => transport.destroy?.()))
})

describe('a runtime pane bridged to an older relay’s terminal', () => {
  it('keeps output the relay printed after the reattach screen instead of clearing it', async () => {
    bridge.attach.mockResolvedValueOnce({ status: 'unverifiable' })
    const transport = createLegacyRelayBridgeTransport(PTY, innerTransport())
    const seen: string[] = []
    const cb = callbacks()
    cb.onData.mockImplementation((data: string) => seen.push(`data:${data}`))
    cb.onReplayData.mockImplementation((replay: string) => seen.push(`screen:${replay}`))
    await transport.connect({ url: '', sessionId: PTY, callbacks: cb })
    let answer: (result: unknown) => void = () => {}
    bridge.attach.mockImplementationOnce(async (args: { replayInStream?: boolean }) => {
      // Main's stream while the reply is on its way: the screen, then output printed after it.
      if (args.replayInStream) {
        bridge.replay.forEach((listener) => listener({ ptyId: PTY, replay: 'SCREEN' }))
      }
      bridge.data.forEach((listener) => listener({ ptyId: PTY, data: 'after' }))
      return new Promise((resolve) => (answer = resolve)).then(() => ({
        status: 'attached',
        replay: args.replayInStream ? '' : 'SCREEN',
        acquisitionId: 1
      }))
    })
    publishPanes([{ ptyId: PTY, targetId: 'ssh-box', tabId: 'tab-1', state: 'live' }])
    await vi.waitFor(() => expect(bridge.attach).toHaveBeenCalledTimes(2))
    answer(undefined)
    await vi.waitFor(() => expect(transport.isConnected()).toBe(true))
    expect(seen).toEqual(['screen:SCREEN', 'data:after'])
  })
})
