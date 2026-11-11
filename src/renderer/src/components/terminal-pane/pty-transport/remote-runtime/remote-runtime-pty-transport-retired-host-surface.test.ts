import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  readyHostSessionInventoryResponse
} from '../remote/remote-runtime-pty-transport-test-harness'
import type { MultiplexSubscriptionCallbacks } from '../remote/remote-runtime-pty-transport-stream-fixtures'

const appStore = vi.hoisted(() => ({
  getState: vi.fn(() => {
    throw new Error('These transport fixtures must not read app-store ownership')
  })
}))

vi.mock('@/store/index', () => ({ useAppStore: { getState: appStore.getState } }))

afterEach(() => {
  expect(appStore.getState).not.toHaveBeenCalled()
})

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const { runtimeCall, runtimeSubscribe, latestSubscribePayload, resetRemoteRuntimeTransport } =
  createRemoteRuntimeTransportMocks({
    getCallbacks: () => subscriptionCallbacks,
    setCallbacks: (callbacks) => {
      subscriptionCallbacks = callbacks
    },
    getResolvedPaneHandle: () => resolvedPaneHandle,
    setResolvedPaneHandle: (handle) => {
      resolvedPaneHandle = handle
    }
  })

type HostAnswers = {
  retired: string
  show: Record<string, unknown> | 'terminal_not_found'
}

/** A host whose pane surface was retired when its process exited: no surface, only the close record. */
function answerAsHostThatRetired({ retired, show }: HostAnswers): void {
  const defaultCall = runtimeCall.getMockImplementation()
  runtimeCall.mockImplementation(async (args: { method: string; params?: unknown }) => {
    if (args.method === 'session.tabs.activate') {
      return { ok: false, error: { code: 'tab_not_found', message: 'tab_not_found' } }
    }
    if (args.method === 'session.tabs.list') {
      return {
        ok: true,
        result: {
          worktree: 'wt-1',
          publicationEpoch: 'epoch-ready',
          snapshotVersion: 3,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: [],
          retiredTerminalSurfaces: [
            { parentTabId: 'host-tab-1', leafId: 'pane:1', ptyId: 'pty-1', terminal: retired }
          ]
        }
      }
    }
    if (args.method === 'terminal.resolvePane') {
      return { ok: false, error: { code: 'terminal_not_found', message: 'terminal_not_found' } }
    }
    if (args.method === 'terminal.show') {
      if (show === 'terminal_not_found') {
        return { ok: false, error: { code: 'terminal_not_found', message: 'terminal_not_found' } }
      }
      return { ok: true, result: { terminal: { handle: retired, ...show } } }
    }
    return defaultCall?.(args)
  })
}

const EXITED_127 = {
  connected: false,
  verdict: 'exited',
  exitCause: { kind: 'exited', exitCode: 127 }
}

async function createHostMirror(onPtyExit = vi.fn(), onPtySpawn = vi.fn()) {
  const onHostReboundExitedPty = vi.fn()
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId: 'web-terminal-host-tab-1',
    leafId: 'pane:1',
    onPtyExit,
    onPtySpawn,
    onHostReboundExitedPty
  })
  return { transport, onPtyExit, onPtySpawn, onHostReboundExitedPty }
}

async function publishHostSurface(terminal: string | null, snapshotVersion: number): Promise<void> {
  // Why dynamic: the harness resets modules, so the transport's channel is the freshly loaded one.
  const { queueAcceptedWebSessionTerminalSnapshot } =
    await import('../../../../runtime/web-session-tabs-sync/terminal-handles/web-session-terminal-handle-events')
  queueAcceptedWebSessionTerminalSnapshot(
    {
      worktree: 'wt-1',
      publicationEpoch: 'epoch-ready',
      snapshotVersion,
      activeGroupId: null,
      activeTabId: terminal ? 'host-tab-1::pane:1' : null,
      activeTabType: terminal ? 'terminal' : null,
      tabs: terminal
        ? [
            {
              type: 'terminal',
              id: 'host-tab-1::pane:1',
              parentTabId: 'host-tab-1',
              leafId: 'pane:1',
              title: 'Terminal',
              isActive: true,
              status: 'ready',
              terminal
            }
          ]
        : []
    },
    'env-1'
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('remote runtime pane whose host retired its surface (#38151)', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  it('ends a pane opened after its session already exited, with the exit code', async () => {
    answerAsHostThatRetired({ retired: 'terminal-ended', show: EXITED_127 })
    const { transport, onPtyExit, onPtySpawn } = await createHostMirror()

    await transport.connect({ url: '', callbacks: {} })

    await vi.waitFor(() =>
      expect(onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-ended', 127)
    )
    expect(onPtySpawn).toHaveBeenCalledWith('remote:env-1@@terminal-ended')
    expect(onPtyExit).toHaveBeenCalledOnce()
    expect(runtimeSubscribe).not.toHaveBeenCalled()
    expect(transport.getRecoveryState?.().phase).toBe('ended')
    transport.destroy?.()
  })

  it('ends the pane with the exit code when its stream ends on the exit', async () => {
    const { transport, onPtyExit } = await createHostMirror()
    await transport.connect({ url: '', callbacks: {} })
    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledOnce())
    answerAsHostThatRetired({
      retired: 'terminal-1',
      show: { connected: false, verdict: 'exited', exitCause: { kind: 'exited', exitCode: 2 } }
    })

    const { streamId } = latestSubscribePayload()
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'end', streamId, verdict: 'exited' }
    })

    await vi.waitFor(() => expect(onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-1', 2))
    expect(onPtyExit).toHaveBeenCalledOnce()
    expect(runtimeSubscribe).toHaveBeenCalledOnce()
    expect(transport.getRecoveryState?.().phase).toBe('ended')
    transport.destroy?.()
  })

  it('ends the pane on the close record alone when the host no longer keeps the terminal', async () => {
    const { transport, onPtyExit } = await createHostMirror()
    await transport.connect({ url: '', callbacks: {} })
    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledOnce())
    answerAsHostThatRetired({ retired: 'terminal-1', show: 'terminal_not_found' })

    const { streamId } = latestSubscribePayload()
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'end', streamId, verdict: 'exited' }
    })

    await vi.waitFor(() => expect(onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-1'))
    expect(transport.getRecoveryState?.().phase).toBe('ended')
    transport.destroy?.()
  })

  it('hands the ended pane to a replacement the host publishes later', async () => {
    answerAsHostThatRetired({ retired: 'terminal-ended', show: EXITED_127 })
    const exitRead = Promise.withResolvers<void>()
    const answer = runtimeCall.getMockImplementation()
    runtimeCall.mockImplementation(async (args: { method: string; params?: unknown }) => {
      if (args.method === 'terminal.show') {
        await exitRead.promise
      }
      return answer?.(args)
    })
    const { transport, onPtyExit, onHostReboundExitedPty } = await createHostMirror()

    void transport.connect({ url: '', callbacks: {} })
    await vi.waitFor(() =>
      expect(runtimeCall).toHaveBeenCalledWith(expect.objectContaining({ method: 'terminal.show' }))
    )
    await publishHostSurface(null, 4)
    exitRead.resolve()
    await vi.waitFor(() => expect(onPtyExit).toHaveBeenCalledOnce())
    await publishHostSurface('terminal-restarted', 5)

    await vi.waitFor(() =>
      expect(onHostReboundExitedPty).toHaveBeenCalledWith('remote:env-1@@terminal-restarted')
    )
    expect(onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-ended', 127)
    transport.destroy?.()
  })

  it('keeps a pane the host restarted after the close record it first read', async () => {
    const answerBeforeRetirement = runtimeCall.getMockImplementation()
    answerAsHostThatRetired({ retired: 'terminal-ended', show: EXITED_127 })
    const retiredAnswer = runtimeCall.getMockImplementation()
    let lists = 0
    runtimeCall.mockImplementation(async (args: { method: string; params?: unknown }) => {
      if (args.method === 'session.tabs.list' && lists++ > 0) {
        resolvedPaneHandle = 'terminal-restarted'
        return readyHostSessionInventoryResponse('terminal-restarted')
      }
      if (args.method === 'terminal.resolvePane' && lists > 1) {
        return answerBeforeRetirement?.(args)
      }
      if (args.method === 'session.tabs.activate' && lists > 1) {
        return answerBeforeRetirement?.(args)
      }
      return retiredAnswer?.(args)
    })
    const { transport, onPtyExit } = await createHostMirror()

    void transport.connect({ url: '', callbacks: {} })

    await vi.waitFor(() => expect(latestSubscribePayload().terminal).toBe('terminal-restarted'), {
      timeout: 5_000
    })
    expect(onPtyExit).not.toHaveBeenCalled()
    transport.destroy?.()
  })
})
