import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson
} from '../../../../shared/terminal-stream-protocol'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const {
  runtimeCall,
  runtimeSubscribe,
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

  it('does not publish a spawn callback while reconnecting a mirrored web terminal', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtySpawn = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-tab-1',
      leafId: 'pane:1',
      onPtySpawn
    })

    const result = await transport.connect({
      url: '',
      sessionId: 'remote:env-1@@terminal-old',
      cols: 80,
      rows: 24,
      callbacks: {}
    })

    expect(result).toMatchObject({
      id: 'remote:env-1@@terminal-1',
      isReattach: true
    })
    expect(onPtySpawn).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
  })

  it('resolves a HUB-native SSH PTY wake hint to its runtime terminal handle', async () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtimeCall.mockImplementation(async (request: { method: string; params?: unknown }) => {
      if (request.method === 'terminal.resolvePane') {
        return {
          ok: true,
          result: {
            terminal: {
              handle: 'hub-terminal-1',
              tabId: 'tab-1',
              leafId,
              ptyId: 'ssh:hub-private@@pty-2',
              worktreeId: 'wt-1',
              executionHostId: 'ssh:hub-private',
              hostPlatform: 'win32'
            }
          }
        }
      }
      throw new Error(`Unexpected method ${request.method}`)
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('hub-env', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId
    })

    const result = await transport.connect({
      url: '',
      cols: 120,
      rows: 40,
      sessionId: 'ssh:hub-private@@pty-2',
      callbacks: {}
    })

    expect(result).toEqual({
      id: 'remote:hub-env@@hub-terminal-1',
      replay: '',
      isReattach: true
    })
    expect(transport.getPtyId()).toBe('remote:hub-env@@hub-terminal-1')
    expect(transport.getExecutionHostId?.()).toBe('ssh:hub-private')
    expect(transport.getRemotePlatform?.()).toBe('win32')
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'hub-env',
        method: 'terminal.resolvePane',
        params: {
          paneKey: `tab-1:${leafId}`,
          worktreeId: 'wt-1'
        }
      })
    )
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.create' })
    )
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    expect(latestSubscribePayload()).toMatchObject({ terminal: 'hub-terminal-1' })
  })

  it('verifies a legacy pane response against the requested worktree session', async () => {
    runtimeCall.mockImplementation(async (request: { method: string; params?: unknown }) => {
      if (request.method === 'terminal.resolvePane') {
        return {
          ok: true,
          result: {
            terminal: {
              handle: 'legacy-terminal-1',
              tabId: 'tab-1',
              leafId: 'pane:1',
              ptyId: 'ssh:hub-private@@pty-2'
            }
          }
        }
      }
      if (request.method === 'session.tabs.list') {
        return {
          ok: true,
          result: {
            worktree: 'id:wt-1',
            publicationEpoch: 'legacy-epoch',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: 'tab-1',
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: 'tab-1::pane:1',
                parentTabId: 'tab-1',
                leafId: 'pane:1',
                title: 'Terminal',
                isActive: true,
                status: 'ready',
                terminal: 'legacy-terminal-1'
              }
            ]
          }
        }
      }
      throw new Error(`Unexpected method ${request.method}`)
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('legacy-env', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    transport.attach({
      existingPtyId: 'remote:legacy-env@@legacy-terminal-1',
      cols: 100,
      rows: 30,
      callbacks: {}
    })

    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    emitSnapshot(latestSubscribePayload().streamId, 'legacy state')
    expect(transport.isConnected()).toBe(true)
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'session.tabs.list',
        params: { worktree: 'id:wt-1' }
      })
    )
    expect(latestSubscribePayload()).toMatchObject({ terminal: 'legacy-terminal-1' })
  })

  it('rejects a legacy pane handle absent from the requested worktree session', async () => {
    runtimeCall.mockImplementation(async (request: { method: string }) => {
      if (request.method === 'terminal.resolvePane') {
        return {
          ok: true,
          result: {
            terminal: {
              handle: 'foreign-terminal',
              tabId: 'tab-1',
              leafId: 'pane:1',
              ptyId: 'ssh:hub-private@@foreign-pty'
            }
          }
        }
      }
      if (request.method === 'session.tabs.list') {
        return {
          ok: true,
          result: {
            worktree: 'id:wt-1',
            publicationEpoch: 'legacy-epoch',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: 'tab-1',
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: 'tab-1::pane:1',
                parentTabId: 'tab-1',
                leafId: 'pane:1',
                title: 'Terminal',
                isActive: true,
                status: 'ready',
                terminal: 'worktree-terminal'
              }
            ]
          }
        }
      }
      throw new Error(`Unexpected method ${request.method}`)
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('legacy-env', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    transport.attach({
      existingPtyId: 'remote:legacy-env@@foreign-terminal',
      callbacks: { onError }
    })

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('terminal_owner_mismatch'))
    expect(transport.isConnected()).toBe(false)
    expect(runtimeSubscribe).not.toHaveBeenCalled()
  })

  it('scopes the same legacy handle independently for each runtime environment', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const first = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'leaf-1'
    })
    const second = createRemoteRuntimePtyTransport('env-2', {
      worktreeId: 'wt-2',
      tabId: 'tab-2',
      leafId: 'leaf-2'
    })

    first.attach({ existingPtyId: 'remote:terminal-1', callbacks: {} })
    second.attach({ existingPtyId: 'remote:terminal-1', callbacks: {} })

    await vi.waitFor(() => {
      expect(first.getPtyId()).toBe('remote:env-1@@terminal-1')
      expect(second.getPtyId()).toBe('remote:env-2@@terminal-1')
    })
  })

  it('parks passive peers when another remote desktop owns the grid', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { getFitOverrideForPty, setFitOverride } =
      await import('@/lib/pane-manager/mobile-fit-overrides')
    const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1' })
    await transport.connect({ url: '', cols: 120, rows: 40, callbacks: {} })
    const { streamId } = latestSubscribePayload()
    const ptyId = transport.getPtyId()
    expect(ptyId).not.toBeNull()

    subscriptionCallbacks?.onResponse({
      ok: true,
      result: {
        type: 'fit-override-changed',
        streamId,
        mode: 'remote-desktop-fit',
        cols: 96,
        rows: 32
      }
    })

    expect(ptyId ? getFitOverrideForPty(ptyId) : null).toEqual({
      mode: 'remote-desktop-fit',
      cols: 96,
      rows: 32
    })
    if (ptyId) {
      setFitOverride(ptyId, 'desktop-fit', 0, 0)
    }
  })

  it('gives separate paired viewers of the same host pane distinct refresh identities', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const first = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })
    const second = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    first.attach({ existingPtyId: 'remote:terminal-1', cols: 80, rows: 24, callbacks: {} })
    second.attach({ existingPtyId: 'remote:terminal-1', cols: 120, rows: 40, callbacks: {} })

    await vi.waitFor(() => {
      const subscribeFrames = subscriptionSendBinary.mock.calls
        .map((call) => decodeTerminalStreamFrame(call[0]))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Subscribe)
      expect(subscribeFrames).toHaveLength(2)
      const clientIds = subscribeFrames.map((frame) => {
        const payload = frame
          ? decodeTerminalStreamJson<{ client: { id: string } }>(frame.payload)
          : null
        return payload?.client.id
      })
      expect(clientIds[0]).toMatch(/^desktop:tab-1:pane:1:/)
      expect(clientIds[1]).toMatch(/^desktop:tab-1:pane:1:/)
      expect(clientIds[0]).not.toBe(clientIds[1])
    })

    first.destroy?.()
    second.destroy?.()
  })

  it('does not let an encoded restored terminal id override the current worktree owner', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-2', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-1',
      cols: 120,
      rows: 40,
      callbacks: {}
    })

    await vi.waitFor(() => {
      expect(runtimeSubscribe).toHaveBeenCalled()
    })

    expect(runtimeSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-2',
        method: 'terminal.multiplex'
      }),
      expect.any(Object)
    )
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    expect(latestSubscribePayload()).toMatchObject({
      terminal: 'terminal-1',
      viewport: { cols: 120, rows: 40 }
    })
  })

  it('attaches an environment-scoped handle when an older runtime lacks pane resolution', async () => {
    runtimeCall.mockImplementation(async (request: { method: string }) => {
      if (request.method === 'terminal.resolvePane') {
        return {
          ok: false,
          error: { code: 'method_not_found', message: 'Unknown method: terminal.resolvePane' }
        }
      }
      return { ok: true, result: {} }
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('legacy-env', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    transport.attach({
      existingPtyId: 'remote:legacy-env@@terminal-legacy',
      cols: 80,
      rows: 24,
      callbacks: {}
    })

    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    emitSnapshot(latestSubscribePayload().streamId, 'legacy state')
    expect(transport.isConnected()).toBe(true)
    expect(transport.getPtyId()).toBe('remote:legacy-env@@terminal-legacy')
    expect(runtimeSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'legacy-env', method: 'terminal.multiplex' }),
      expect.any(Object)
    )
  })

  it('re-derives the host session handle after a transport close instead of resubscribing the stale one', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { getAllOverrides, setFitOverride } =
      await import('@/lib/pane-manager/mobile-fit-overrides')
    const { getAllDrivers, setDriverForPty } =
      await import('@/lib/pane-manager/mobile-driver-state')
    const onPtySpawn = vi.fn()
    const onPtyRebind = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-tab-1',
      leafId: 'pane:1',
      onPtySpawn,
      onPtyRebind
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-1',
      cols: 80,
      rows: 24,
      callbacks: {}
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-1' })
    setFitOverride('remote:env-1@@terminal-1', 'mobile-fit', 49, 20)
    setDriverForPty('remote:env-1@@terminal-1', { kind: 'mobile', clientId: 'phone-1' })

    // Why: while the tunnel was down the host re-minted this pane's handle;
    // resubscribing the stale closure handle would bind the mirror to a
    // different PTY (#7718). The transport must re-derive from the snapshot.
    runtimeCall.mockImplementation(async (args: { method: string }) =>
      args.method === 'session.tabs.list'
        ? {
            ok: true,
            result: {
              worktree: 'wt-1',
              publicationEpoch: 'epoch-1',
              snapshotVersion: 2,
              activeGroupId: null,
              activeTabId: 'tab-1::pane:1',
              activeTabType: 'terminal',
              tabs: [
                {
                  type: 'terminal',
                  id: 'tab-1::pane:1',
                  parentTabId: 'tab-1',
                  leafId: 'pane:1',
                  title: 'Terminal',
                  isActive: true,
                  status: 'ready',
                  terminal: 'terminal-2'
                }
              ]
            }
          }
        : { ok: true, result: {} }
    )
    const subscribeCallsBefore = runtimeSubscribe.mock.calls.length

    // The dedicated multiplex socket dies (liveness/close) → onTransportClose.
    subscriptionCallbacks?.onClose?.()

    await vi.waitFor(() =>
      expect(runtimeSubscribe.mock.calls.length).toBeGreaterThan(subscribeCallsBefore)
    )
    await vi.waitFor(() =>
      expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-2' })
    )
    expect(transport.getPtyId()).toContain('terminal-2')
    expect(onPtySpawn).not.toHaveBeenCalled()
    expect(onPtyRebind).toHaveBeenCalledWith(
      expect.stringContaining('terminal-2'),
      expect.stringContaining('terminal-1')
    )
    expect([...getAllOverrides().keys()]).toEqual(['remote:env-1@@terminal-2'])
    expect([...getAllDrivers().keys()]).toEqual(['remote:env-1@@terminal-2'])
  })

  it('retires the mirror when the host no longer publishes the surface after a transport close', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtyExit = vi.fn()
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-tab-1',
      leafId: 'pane:1',
      onPtyExit
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-1',
      cols: 80,
      rows: 24,
      callbacks: { onError }
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())

    runtimeCall.mockImplementation(async (args: { method: string }) =>
      args.method === 'session.tabs.list'
        ? {
            ok: true,
            result: {
              worktree: 'wt-1',
              publicationEpoch: 'epoch-1',
              snapshotVersion: 2,
              activeGroupId: null,
              activeTabId: null,
              activeTabType: null,
              tabs: []
            }
          }
        : { ok: true, result: {} }
    )

    subscriptionCallbacks?.onClose?.()

    // Why: no red xterm error — retire quietly and let the next session-tabs
    // snapshot drive respawn/removal.
    await vi.waitFor(() => expect(onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-1', -1))
    expect(transport.getPtyId()).toBeNull()
    expect(onError).not.toHaveBeenCalled()
  })

  it('does not close host-owned terminal handles attached from session snapshots', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-tab-1',
      leafId: 'pane:1'
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-1',
      cols: 80,
      rows: 24,
      callbacks: {}
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    runtimeCall.mockClear()

    transport.destroy?.()

    expect(transport.getRecoveryState?.().phase).toBe('disposed')
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.close'
      })
    )
  })

  it('detaches laptop-created remote runtime terminals without closing the server session', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    await transport.connect({ url: '', callbacks: {} })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    runtimeCall.mockClear()

    transport.destroy?.()

    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.close'
      })
    )
  })
})
