import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRemoteRuntimeTransportMocks } from '../remote/remote-runtime-pty-transport-test-harness'
import type { MultiplexSubscriptionCallbacks } from '../remote/remote-runtime-pty-transport-stream-fixtures'
import { TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY } from '../../../../../../shared/terminal/runtime-policy/terminal-runtime-capabilities'
import { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } from './recovery/remote-runtime-pty-recovery-limits'

vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => {
      throw new Error('These transport fixtures must not read app-store ownership')
    }
  }
}))

let callbacks: MultiplexSubscriptionCallbacks = null
let resolvedHandle = 'terminal-1'
const {
  runtimeCall,
  latestSubscribePayload,
  subscribedTerminalHandles,
  subscribeFrameCount,
  emitSnapshot,
  inputFrameTexts,
  resetRemoteRuntimeTransport
} = createRemoteRuntimeTransportMocks({
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

// CJ9: on a healthy link this error used to go fatal and idle, dropping typed input.
describe('remote terminal whose host history is briefly unavailable', () => {
  it('reattaches the same terminal and delivers input typed meanwhile', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onExit = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:2'
      })
      await transport.connect({ url: '', callbacks: { onExit } })
      const first = latestSubscribePayload().streamId
      callbacks?.onResponse({
        ok: true,
        result: { type: 'error', streamId: first, message: 'terminal_history_unavailable' }
      })
      callbacks?.onResponse({ ok: true, result: { type: 'end', streamId: first } })
      expect(transport.sendInput('typed\r', 'driving')).toBe(true)

      for (let waited = 0; waited < 30 && subscribeFrameCount() < 2; waited += 1) {
        await vi.advanceTimersByTimeAsync(1_000)
      }
      expect(subscribeFrameCount()).toBe(2)
      const { streamId } = latestSubscribePayload()
      callbacks?.onResponse({ ok: true, result: { type: 'subscribed', streamId } })
      emitSnapshot(streamId, 'prompt$ ')
      await vi.advanceTimersByTimeAsync(0)

      expect(subscribedTerminalHandles()).toEqual(['terminal-1', 'terminal-1'])
      await vi.waitFor(() => expect(inputFrameTexts().join('')).toBe('typed\r'))
      expect(onExit).not.toHaveBeenCalled()
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })
})

type CreateParams = {
  clientMutationId?: string
  reconcileExisting?: boolean
  providerSession?: { id: string }
}

const RESUME = { key: 'session_id', id: 'provider-session-1' } as const

// GH1346: the host may refuse a create for unavailable history after spawning its terminal.
describe('remote terminal create refused for unavailable host history', () => {
  function installHost(capabilities: string[]) {
    const spawned: (string | undefined)[] = []
    let historyReady = false
    const healthyCall = runtimeCall.getMockImplementation()
    runtimeCall.mockImplementation(
      async (request: { method: string; selector: string; params?: CreateParams }) => {
        if (request.method === 'status.get') {
          return {
            ok: true,
            result: {
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities
            }
          }
        }
        const ensure = request.method === 'terminal.ensureAgentSession'
        if (request.method !== 'terminal.create' && !ensure) {
          return healthyCall?.(request)
        }
        // An ensure adopts its provider session's terminal; a create adopts only when reconciling.
        const key = ensure ? request.params?.providerSession?.id : request.params?.clientMutationId
        const existing = spawned.includes(key)
        if (!existing || !(ensure || request.params?.reconcileExisting)) {
          spawned.push(key)
        }
        return historyReady
          ? {
              ok: true,
              result: {
                terminal: { handle: 'terminal-1' },
                ...(ensure ? { disposition: existing ? 'adopted' : 'created' } : {})
              }
            }
          : { ok: false, error: { code: 'runtime_error', message: 'terminal_history_unavailable' } }
      }
    )
    const calls = (method: string): CreateParams[] =>
      runtimeCall.mock.calls
        .filter(([request]) => request.method === method)
        .map(([request]) => request.params)
    return {
      spawned,
      creates: () => calls('terminal.create'),
      ensures: () => calls('terminal.ensureAgentSession'),
      restoreHistory: () => {
        historyReady = true
      }
    }
  }

  async function mountRefusedPane(agent?: {
    launchAgent: 'claude'
    resumeProviderSession: typeof RESUME
  }) {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      ...agent
    })
    void transport.connect({ url: '', cols: 80, rows: 24, callbacks: {} })
    await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1_000)
    return transport
  }

  async function attachAndType(transport: Awaited<ReturnType<typeof mountRefusedPane>>) {
    expect(transport.retryRecovery?.()).toBe(true)
    await vi.waitFor(() => expect(subscribeFrameCount()).toBe(1))
    const { streamId } = latestSubscribePayload()
    callbacks?.onResponse({ ok: true, result: { type: 'subscribed', streamId } })
    emitSnapshot(streamId, 'prompt$ ')
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.sendInput('typed\r', 'driving')).toBe(true)
    await vi.waitFor(() => expect(inputFrameTexts().join('')).toBe('typed\r'))
    expect(subscribedTerminalHandles()).toEqual(['terminal-1'])
    expect(new Set(runtimeCall.mock.calls.map(([request]) => request.selector))).toEqual(
      new Set(['env-1'])
    )
  }

  it('reconciles that one create, then Retry attaches it and delivers input', async () => {
    vi.useFakeTimers()
    try {
      const host = installHost([TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY])
      const transport = await mountRefusedPane()

      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      const [first, ...reconciles] = host.creates()
      expect(first.reconcileExisting).toBeUndefined()
      expect(reconciles.length).toBeGreaterThan(0)

      host.restoreHistory()
      await attachAndType(transport)

      expect(host.spawned).toEqual([first.clientMutationId])
      expect(first.clientMutationId).toBeTruthy()
      for (const reconcile of host.creates().slice(1)) {
        expect(reconcile).toMatchObject({
          clientMutationId: first.clientMutationId,
          reconcileExisting: true
        })
      }
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-ensures an agent session with its original request, then Retry attaches it', async () => {
    vi.useFakeTimers()
    try {
      const host = installHost(['agent-session.host-authority.v1'])
      const transport = await mountRefusedPane({
        launchAgent: 'claude',
        resumeProviderSession: RESUME
      })

      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      const [first, ...reensures] = host.ensures()
      expect(first).toMatchObject({
        providerSession: RESUME,
        placement: { tabId: 'tab-1', leafId: 'pane:1' }
      })
      expect(reensures.length).toBeGreaterThan(0)

      host.restoreHistory()
      await attachAndType(transport)

      expect(host.spawned).toEqual([RESUME.id])
      for (const reensure of host.ensures().slice(1)) {
        expect(reensure).toEqual(first)
      }
      expect(host.creates()).toEqual([])
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('never resends the create to a host that cannot reconcile it', async () => {
    vi.useFakeTimers()
    try {
      const host = installHost([])
      const transport = await mountRefusedPane()

      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      host.restoreHistory()
      transport.retryRecovery?.()
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1_000)

      expect(host.creates()).toHaveLength(1)
      expect(host.spawned).toHaveLength(1)
      expect(subscribeFrameCount()).toBe(0)
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })
})
