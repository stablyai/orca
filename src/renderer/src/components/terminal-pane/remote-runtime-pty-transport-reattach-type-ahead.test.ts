import { beforeEach, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamText
} from '../../../../shared/terminal-stream-protocol'
import { createDeferred } from './pty-connection-test-async'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

let callbacks: MultiplexSubscriptionCallbacks = null
let resolvedHandle = 'terminal-1'
const { runtimeCall, latestFrameForOpcode, resetRemoteRuntimeTransport } =
  createRemoteRuntimeTransportMocks({
    getCallbacks: () => callbacks,
    setCallbacks: (value) => {
      callbacks = value
    },
    getResolvedPaneHandle: () => resolvedHandle,
    setResolvedPaneHandle: (value) => {
      resolvedHandle = value
    }
  })

beforeEach(resetRemoteRuntimeTransport)

it('sends typing from a restored screen after the host finishes resolving its original pane', async () => {
  const resolution = createDeferred<void>()
  const call = runtimeCall.getMockImplementation()
  runtimeCall.mockImplementation(async (request: { method: string }) => {
    if (request.method === 'terminal.resolvePane') {
      await resolution.promise
    }
    return call?.(request)
  })
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId: 'web-terminal-host-tab-1',
    leafId: 'pane:1'
  })
  try {
    expect(transport.sendInput('probe-', 'driving')).toBe(true)
    const connecting = transport.connect({
      url: '',
      sessionId: 'remote:env-1@@terminal-1',
      callbacks: {}
    })
    await vi.waitFor(() => {
      expect(runtimeCall).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.resolvePane' })
      )
    })
    expect(transport.getPtyId()).toBeNull()
    expect(transport.sendInput('cold-parked\r', 'driving')).toBe(true)
    expect(latestFrameForOpcode(TerminalStreamOpcode.Input)).toBeUndefined()
    resolution.resolve()
    await connecting
    await vi.waitFor(() => {
      const frame = latestFrameForOpcode(TerminalStreamOpcode.Input)
      expect(frame && decodeTerminalStreamText(frame.payload)).toBe('probe-cold-parked\r')
    })
  } finally {
    resolution.resolve()
    transport.destroy?.()
  }
})
