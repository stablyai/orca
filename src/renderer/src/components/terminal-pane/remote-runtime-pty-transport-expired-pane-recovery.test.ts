import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

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

describe('createRemoteRuntimePtyTransport', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  it('still retires the regular TUI surface after an explicit terminal exit', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtyExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-tab-1',
      leafId: 'pane:1',
      onPtyExit
    })

    resolvedPaneHandle = 'terminal-exited'
    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-exited',
      cols: 80,
      rows: 24,
      callbacks: {}
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())

    subscriptionCallbacks?.onResponse({
      ok: true,
      result: {
        type: 'error',
        streamId: latestSubscribePayload().streamId,
        message: 'terminal_exited'
      }
    })

    expect(onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-exited')
    expect(transport.getPtyId()).toBeNull()
    expect(transport.isConnected()).toBe(false)
    expect(transport.getRecoveryState?.().phase).toBe('ended')
  })

  it('asks the HUB to recover an expired SSH pane and rebinds the host identity', async () => {
    const onError = vi.fn()
    const onPtyExit = vi.fn()
    const onPtyRebind = vi.fn()
    resolvedPaneHandle = 'terminal-expired'
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('hub-env', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'pane:1',
      onPtyExit,
      onPtyRebind
    })
    transport.attach({
      existingPtyId: 'remote:hub-env@@terminal-expired',
      cols: 80,
      rows: 24,
      callbacks: { onError }
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'terminal.recoverPane') {
        return {
          ok: true,
          result: {
            terminal: {
              handle: 'terminal-replacement',
              tabId: 'host-tab-1',
              leafId: 'pane:1',
              ptyId: 'ssh-private-pty',
              worktreeId: 'wt-1'
            }
          }
        }
      }
      return { ok: true, result: {} }
    })

    subscriptionCallbacks?.onResponse({
      ok: true,
      result: {
        type: 'error',
        streamId: latestSubscribePayload().streamId,
        message: 'SSH_SESSION_EXPIRED: relay identity changed'
      }
    })

    await vi.waitFor(() =>
      expect(transport.getPtyId()).toBe('remote:hub-env@@terminal-replacement')
    )
    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'hub-env',
      method: 'terminal.recoverPane',
      params: {
        paneKey: 'host-tab-1:pane:1',
        worktreeId: 'wt-1',
        expectedTerminal: 'terminal-expired'
      },
      timeoutMs: 15_000
    })
    expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-replacement' })
    expect(onPtyRebind).toHaveBeenCalledWith(
      'remote:hub-env@@terminal-replacement',
      'remote:hub-env@@terminal-expired'
    )
    expect(onPtyExit).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('does not recover a pane whose relay reply was an identity mismatch', async () => {
    // The mismatch suffix means the relay found a LIVE PTY under that id owned by ANOTHER pane, so
    // it is evidence of presence, not absence. This transport is the only caller of
    // terminal.recoverPane, so a bare SSH_SESSION_EXPIRED substring test here put a second agent on
    // one transcript even though main already refuses the respawn on the same reply.
    const onError = vi.fn()
    resolvedPaneHandle = 'terminal-mismatch'
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('hub-env', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'pane:1'
    })
    transport.attach({
      existingPtyId: 'remote:hub-env@@terminal-mismatch',
      callbacks: { onError }
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    runtimeCall.mockClear()

    subscriptionCallbacks?.onResponse({
      ok: true,
      result: {
        type: 'error',
        streamId: latestSubscribePayload().streamId,
        message: 'SSH_SESSION_EXPIRED: pty-1 SSH_PTY_IDENTITY_MISMATCH'
      }
    })

    await vi.waitFor(() => expect(onError).toHaveBeenCalled())
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.recoverPane' })
    )
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.create' })
    )
    expect(transport.getPtyId()).toBe('remote:hub-env@@terminal-mismatch')
  })

  it('fails closed when an older HUB cannot recover an expired SSH pane', async () => {
    const onError = vi.fn()
    resolvedPaneHandle = 'terminal-expired'
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('legacy-hub', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'pane:1'
    })
    transport.attach({
      existingPtyId: 'remote:legacy-hub@@terminal-expired',
      callbacks: { onError }
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'terminal.recoverPane') {
        return {
          ok: false,
          error: { code: 'method_not_found', message: 'Unknown method: terminal.recoverPane' }
        }
      }
      return { ok: true, result: {} }
    })

    subscriptionCallbacks?.onResponse({
      ok: true,
      result: {
        type: 'error',
        streamId: latestSubscribePayload().streamId,
        message: 'SSH_SESSION_EXPIRED: relay identity changed'
      }
    })

    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith('Unknown method: terminal.recoverPane')
    )
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.create' })
    )
    expect(transport.getPtyId()).toBe('remote:legacy-hub@@terminal-expired')
    expect(transport.isConnected()).toBe(false)
  })

  it('ignores stale stream end after reattaching a newer remote terminal', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtyExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      onPtyExit
    })

    resolvedPaneHandle = 'terminal-old'
    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-old',
      cols: 80,
      rows: 24,
      callbacks: {}
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const oldStreamId = latestSubscribePayload().streamId
    const oldSubscriptionCallbacks = subscriptionCallbacks

    resolvedPaneHandle = 'terminal-new'
    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-new',
      cols: 80,
      rows: 24,
      callbacks: {}
    })
    await vi.waitFor(() => {
      expect(transport.getPtyId()).toBe('remote:env-1@@terminal-new')
    })
    oldSubscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'end', streamId: oldStreamId }
    })

    expect(onPtyExit).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-new')
    expect(transport.isConnected()).toBe(false)

    await vi.waitFor(() => {
      expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-new' })
    })
    const newStreamId = latestSubscribePayload().streamId
    emitSnapshot(newStreamId, 'reattached')
    expect(transport.isConnected()).toBe(true)

    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'end', streamId: newStreamId, verdict: 'exited' }
    })

    expect(onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-new')
    expect(transport.getPtyId()).toBeNull()
    expect(transport.isConnected()).toBe(false)
  })
})
