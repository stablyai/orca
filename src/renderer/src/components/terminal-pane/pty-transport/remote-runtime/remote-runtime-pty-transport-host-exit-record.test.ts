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

const {
  runtimeCall,
  subscriptionSendBinary,
  latestSubscribePayload,
  emitSnapshot,
  resetRemoteRuntimeTransport
} = createRemoteRuntimeTransportMocks({
  getCallbacks: () => subscriptionCallbacks,
  setCallbacks: (callbacks) => {
    subscriptionCallbacks = callbacks
  },
  getResolvedPaneHandle: () => resolvedPaneHandle,
  setResolvedPaneHandle: (handle) => {
    resolvedPaneHandle = handle
  }
})

const HOST_TAB_PTY_ID = 'remote:hub-env@@terminal-ended'

type ShowParams = { terminal?: string }

function refuseStream(message: string): void {
  const streamId = latestSubscribePayload().streamId
  subscriptionCallbacks?.onResponse({ ok: true, result: { type: 'error', streamId, message } })
}

function answerShow(terminal: Record<string, unknown>): string[] {
  const shown: string[] = []
  const defaultCall = runtimeCall.getMockImplementation()
  runtimeCall.mockImplementation(async (args: { method: string; params?: ShowParams }) => {
    if (args.method === 'terminal.show') {
      shown.push(args.params?.terminal ?? '')
      return { ok: true, result: { terminal: { handle: 'terminal-ended', ...terminal } } }
    }
    if (args.method === 'session.tabs.list') {
      return readyHostSessionInventoryResponse('terminal-ended')
    }
    return defaultCall?.(args)
  })
  return shown
}

async function attachRestoredHostTab(
  onPtyExit: (ptyId: string, exitCode?: number) => void,
  onHostReboundExitedPty?: (ptyId: string) => void
) {
  resolvedPaneHandle = 'terminal-ended'
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const transport = createRemoteRuntimePtyTransport('hub-env', {
    worktreeId: 'wt-1',
    tabId: 'web-terminal-host-tab-1',
    leafId: 'pane:1',
    onPtyExit,
    ...(onHostReboundExitedPty ? { onHostReboundExitedPty } : {})
  })
  transport.attach({ existingPtyId: HOST_TAB_PTY_ID, callbacks: {} })
  await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
  emitSnapshot(latestSubscribePayload().streamId, 'transcript')
  return transport
}

async function publishHostSurface(
  surface: { terminal: string; incarnationId?: string } | null,
  snapshotVersion: number
): Promise<void> {
  const tab = {
    type: 'terminal' as const,
    id: 'host-tab-1::pane:1',
    parentTabId: 'host-tab-1',
    leafId: 'pane:1',
    title: 'Terminal',
    isActive: true
  }
  // Why dynamic: the harness resets modules, so the transport's channel is the freshly loaded one.
  const { queueAcceptedWebSessionTerminalSnapshot } =
    await import('../../../../runtime/web-session-tabs-sync/terminal-handles/web-session-terminal-handle-events')
  queueAcceptedWebSessionTerminalSnapshot(
    {
      worktree: 'wt-1',
      publicationEpoch: 'epoch-ready',
      snapshotVersion,
      activeGroupId: null,
      activeTabId: tab.id,
      activeTabType: 'terminal',
      tabs: [
        surface
          ? { ...tab, status: 'ready', ...surface }
          : { ...tab, status: 'pending-handle', terminal: null }
      ]
    },
    'hub-env'
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('remote runtime pane whose host session already ended (#31539)', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  it('hands a settled pane back to a process the host published while the exit was confirming', async () => {
    const onHostReboundExitedPty = vi.fn()
    const transport = await attachRestoredHostTab(vi.fn(), onHostReboundExitedPty)
    answerShow({ connected: false, verdict: 'exited', incarnationId: 'inc-1' })
    let answerPane: (value: unknown) => void = () => {}
    const answer = runtimeCall.getMockImplementation()
    runtimeCall.mockImplementation(async (args: { method: string; params?: unknown }) =>
      args.method === 'terminal.resolvePane'
        ? new Promise((resolve) => {
            answerPane = resolve
          })
        : answer?.(args)
    )
    refuseStream('terminal_handle_stale')
    await vi.waitFor(() =>
      expect(runtimeCall).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.resolvePane' })
      )
    )

    await publishHostSurface({ terminal: 'terminal-ended', incarnationId: 'inc-2' }, 4)
    answerPane({
      ok: true,
      result: {
        terminal: {
          handle: 'terminal-ended',
          tabId: 'host-tab-1',
          leafId: 'pane:1',
          worktreeId: 'wt-1',
          incarnationId: 'inc-1'
        }
      }
    })

    await vi.waitFor(() =>
      expect(onHostReboundExitedPty.mock.calls).toEqual([['remote:hub-env@@terminal-ended']])
    )
    transport.destroy?.()
  })
})
