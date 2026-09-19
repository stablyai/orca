import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  decodeTerminalStreamFrame,
  TerminalStreamOpcode
} from '../../../../shared/terminal-stream-protocol'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'
const mocks = createRemoteRuntimeTransportMocks({
  getCallbacks: () => subscriptionCallbacks,
  setCallbacks: (callbacks) => {
    subscriptionCallbacks = callbacks
  },
  getResolvedPaneHandle: () => resolvedPaneHandle,
  setResolvedPaneHandle: (handle) => {
    resolvedPaneHandle = handle
  }
})

describe('remote PTY incarnation recovery', () => {
  beforeEach(() => mocks.resetRemoteRuntimeTransport())

  it.each([true, false])(
    'publishes initial attach identity before its replay (mirror=%s)',
    async (mirror) => {
      const originalCall = mocks.runtimeCall.getMockImplementation()!
      mocks.runtimeCall.mockImplementation(async (request: { method: string }) => {
        const response = await originalCall(request)
        if (request.method === 'terminal.resolvePane') {
          response.result.terminal.incarnationId = 'inc-old'
        }
        return response
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const events: string[] = []
      const onPtySpawn = vi.fn()
      const onPtyRebind = vi.fn((_id: string, _old: string, incarnationId?: string | null) => {
        events.push(`identity:${incarnationId}`)
      })
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: mirror ? 'web-terminal-tab-1' : 'tab-1',
        leafId: 'pane:1',
        onPtySpawn,
        onPtyRebind
      })
      try {
        transport.attach({
          existingPtyId: 'remote:env-1@@terminal-1',
          cols: 75,
          rows: 60,
          callbacks: { onReplayData: () => events.push('replay') }
        })
        await vi.waitFor(() => expect(mocks.subscriptionSendBinary).toHaveBeenCalled())
        mocks.emitSnapshot(mocks.latestSubscribePayload().streamId, 'FRAME')
        await vi.waitFor(() => expect(events).toContain('replay'))
        expect(events).toEqual(['identity:inc-old', 'replay'])
        expect(onPtySpawn).not.toHaveBeenCalled()
      } finally {
        transport.destroy?.()
      }
    }
  )

  it.each(['terminal-1', 'terminal-2'])(
    'uses the persisted session ID for connect reattachment to %s',
    async (nextHandle) => {
      resolvedPaneHandle = nextHandle
      const originalCall = mocks.runtimeCall.getMockImplementation()!
      mocks.runtimeCall.mockImplementation(async (request: { method: string }) => {
        const response = await originalCall(request)
        if (request.method === 'terminal.resolvePane') {
          response.result.terminal.incarnationId = 'inc-new'
        }
        return response
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onPtyRebind = vi.fn()
      const onPtySpawn = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-tab-1',
        leafId: 'pane:1',
        onPtyRebind,
        onPtySpawn
      })
      try {
        await transport.connect({
          url: '',
          sessionId: 'remote:env-1@@terminal-1',
          callbacks: {}
        })
        expect(onPtyRebind).toHaveBeenCalledExactlyOnceWith(
          `remote:env-1@@${nextHandle}`,
          'remote:env-1@@terminal-1',
          'inc-new'
        )
        expect(onPtySpawn).not.toHaveBeenCalled()
      } finally {
        transport.destroy?.()
      }
    }
  )

  it.each(
    [
      { mirror: true, rotate: false, next: null, inventory: false },
      { mirror: false, rotate: false, next: null, inventory: false },
      { mirror: true, rotate: false, next: 'inc-new', inventory: true },
      { mirror: true, rotate: true, next: 'inc-new', inventory: true },
      { mirror: true, rotate: false, next: 'inc-new', inventory: false },
      { mirror: true, rotate: true, next: 'inc-old', inventory: false },
      { mirror: false, rotate: false, next: 'inc-new', inventory: false },
      { mirror: false, rotate: true, next: 'inc-old', inventory: false },
      { mirror: true, rotate: true, next: null, inventory: false }
    ].flatMap((scenario) =>
      (['mobile-fit', 'remote-desktop-fit'] as const).map((holdMode) => ({ ...scenario, holdMode }))
    )
  )(
    'preserves ownership while delivering identity: $mirror/$rotate/$next/$inventory/$holdMode',
    async (scenario) => {
      let incarnationId: string | null = 'inc-old'
      const originalCall = mocks.runtimeCall.getMockImplementation()!
      mocks.runtimeCall.mockImplementation(async (request: { method: string }) => {
        const response = await originalCall(request)
        if (request.method === 'terminal.resolvePane') {
          response.result.terminal.incarnationId = incarnationId
        }
        if (request.method === 'session.tabs.activate' && scenario.inventory) {
          response.result.tabs[0].incarnationId = incarnationId
        }
        return response
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const { setFitOverride, getFitOverrideForPty, onOverrideChange } =
        await import('../../lib/pane-manager/mobile-fit-overrides')
      const { setDriverForPty, getDriverForPty, onDriverChange } =
        await import('../../lib/pane-manager/mobile-driver-state')
      const fitChanged = vi.fn()
      const driverChanged = vi.fn()
      const unsubscribeFit = onOverrideChange(fitChanged)
      const unsubscribeDriver = onDriverChange(driverChanged)
      const onPtyRebind = vi.fn()
      const onPtySpawn = vi.fn()
      const onPtyExit = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: scenario.mirror ? 'web-terminal-tab-1' : 'tab-1',
        leafId: 'pane:1',
        onPtyRebind,
        onPtySpawn,
        onPtyExit
      })
      try {
        await transport.connect({ url: '', callbacks: {} })
        await vi.waitFor(() => expect(mocks.subscriptionSendBinary).toHaveBeenCalled())
        setFitOverride('remote:env-1@@terminal-1', scenario.holdMode, 49, 20)
        setDriverForPty('remote:env-1@@terminal-1', { kind: 'mobile', clientId: 'phone-1' })
        fitChanged.mockClear()
        driverChanged.mockClear()
        const initialSubscriptions = mocks.subscribedTerminalHandles().length
        onPtySpawn.mockClear()
        incarnationId = scenario.next
        if (scenario.rotate) {
          resolvedPaneHandle = 'terminal-2'
        }
        subscriptionCallbacks?.onClose?.()
        await vi.waitFor(() =>
          expect(mocks.subscribedTerminalHandles().length).toBeGreaterThan(initialSubscriptions)
        )
        if (scenario.mirror || scenario.rotate || scenario.next) {
          expect(onPtyRebind).toHaveBeenCalledOnce()
          expect(onPtyRebind).toHaveBeenCalledWith(
            `remote:env-1@@${resolvedPaneHandle}`,
            'remote:env-1@@terminal-1',
            ...(incarnationId ? [incarnationId] : [])
          )
        } else {
          expect(onPtyRebind).not.toHaveBeenCalled()
        }
        const nextPtyId = `remote:env-1@@${resolvedPaneHandle}`
        expect(getFitOverrideForPty(nextPtyId)).toEqual({
          mode: scenario.holdMode,
          cols: 49,
          rows: 20
        })
        expect(getDriverForPty(nextPtyId)).toEqual({ kind: 'mobile', clientId: 'phone-1' })
        if (!scenario.rotate) {
          expect(fitChanged).not.toHaveBeenCalled()
          expect(driverChanged).not.toHaveBeenCalled()
        }
        expect(
          mocks.subscriptionSendBinary.mock.calls.map(
            ([bytes]) => decodeTerminalStreamFrame(bytes)?.opcode
          )
        ).not.toContain(TerminalStreamOpcode.Resize)
        expect(
          mocks.subscriptionSendBinary.mock.calls.map(
            ([bytes]) => decodeTerminalStreamFrame(bytes)?.opcode
          )
        ).not.toContain(TerminalStreamOpcode.ClaimViewport)
        expect(onPtySpawn).not.toHaveBeenCalled()
        expect(onPtyExit).not.toHaveBeenCalled()
      } finally {
        unsubscribeFit()
        unsubscribeDriver()
        transport.destroy?.()
      }
    }
  )
})
