import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamJson,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../../../../shared/terminal/stream/terminal-stream-protocol'
import { createRemoteRuntimeTransportMocks } from '../remote/remote-runtime-pty-transport-test-harness'
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
  latestFrameForOpcode,
  emitSnapshotFrame,
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

describe('createRemoteRuntimePtyTransport', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  it('keeps a mounted HUB mirror alive when the old stream ends before the replacement snapshot', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const handleEvents =
      await import('../../../../runtime/web-session-tabs-sync/terminal-handles/web-session-terminal-handle-events')
    const onPtyExit = vi.fn()
    const onPtySpawn = vi.fn()
    const onPtyRebind = vi.fn()
    const onExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('hub-env', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'pane:1',
      onPtyExit,
      onPtySpawn,
      onPtyRebind
    })

    transport.attach({
      existingPtyId: 'remote:hub-env@@terminal-before-restart',
      cols: 100,
      rows: 30,
      callbacks: { onExit }
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const oldStreamId = latestSubscribePayload().streamId
    emitSnapshot(oldStreamId, 'before restart')
    expect(transport.isConnected()).toBe(true)

    runtimeCall.mockImplementation(async (args: { method: string }) =>
      args.method === 'session.tabs.list' ? new Promise(() => {}) : { ok: true, result: {} }
    )
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'end', streamId: oldStreamId, code: 0 }
    })
    const replacementSnapshot = transport.serializeBuffer?.({ scrollbackRows: 5000 })
    let snapshotSettled = false
    void replacementSnapshot?.then(() => {
      snapshotSettled = true
    })
    await Promise.resolve()

    expect(onExit).not.toHaveBeenCalled()
    expect(onPtyExit).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBe('remote:hub-env@@terminal-1')
    expect(snapshotSettled).toBe(false)
    expect(handleEvents.getWebSessionTerminalHandleSubscriberCountForTests()).toBe(1)

    handleEvents.queueAcceptedWebSessionTerminalSnapshot(
      {
        worktree: 'wt-1',
        publicationEpoch: 'epoch-after-restart',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: 'host-tab-1::pane:1',
        activeTabType: 'terminal',
        tabs: [
          {
            type: 'terminal',
            id: 'host-tab-1::pane:1',
            parentTabId: 'host-tab-1',
            leafId: 'pane:1',
            title: 'Terminal',
            isActive: true,
            status: 'ready',
            terminal: 'terminal-after-restart'
          }
        ]
      },
      'hub-env'
    )

    await vi.waitFor(() =>
      expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-after-restart' })
    )
    expect(transport.getPtyId()).toBe('remote:hub-env@@terminal-after-restart')
    expect(onPtyRebind).toHaveBeenCalledWith(
      'remote:hub-env@@terminal-after-restart',
      'remote:hub-env@@terminal-1'
    )
    expect(onPtySpawn).not.toHaveBeenCalled()
    expect(onPtyExit).not.toHaveBeenCalled()
    expect(onExit).not.toHaveBeenCalled()
    emitSnapshot(latestSubscribePayload().streamId, 'replacement initial state')
    await vi.waitFor(() =>
      expect(latestFrameForOpcode(TerminalStreamOpcode.SnapshotRequest)).toBeDefined()
    )
    const requestFrame = latestFrameForOpcode(TerminalStreamOpcode.SnapshotRequest)
    const request = requestFrame
      ? decodeTerminalStreamJson<{ requestId?: number }>(requestFrame.payload)
      : null
    emitSnapshotFrame(
      latestSubscribePayload().streamId,
      TerminalStreamOpcode.SnapshotStart,
      encodeTerminalStreamJson({
        kind: 'scrollback',
        requestId: request?.requestId,
        cols: 100,
        rows: 30
      })
    )
    emitSnapshotFrame(
      latestSubscribePayload().streamId,
      TerminalStreamOpcode.SnapshotChunk,
      encodeTerminalStreamText('replacement authoritative state')
    )
    emitSnapshotFrame(
      latestSubscribePayload().streamId,
      TerminalStreamOpcode.SnapshotEnd,
      new Uint8Array()
    )
    await expect(replacementSnapshot).resolves.toMatchObject({
      data: 'replacement authoritative state',
      cols: 100,
      rows: 30
    })
  })
})
