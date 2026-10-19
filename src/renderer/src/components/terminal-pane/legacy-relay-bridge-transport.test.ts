import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LegacyRelayBridgedPane } from '../../../../shared/legacy-relay-bridge-contract'
import type { PtyTransport } from './pty-transport-types'

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
const { legacyRelayBridgePtyIdForPane, legacyRelayBridgedPtyIdsForClosingTab } =
  await import('./legacy-relay-bridge-panes')

const created: PtyTransport[] = []
function createLegacyRelayBridgeTransport(ptyId: string, inner: PtyTransport): PtyTransport {
  const transport = createTransport(ptyId, inner)
  created.push(transport)
  return transport
}

function publishPanes(panes: LegacyRelayBridgedPane[]): void {
  bridge.panes.forEach((listener) => listener(panes))
}

/** Main's reattach: the screen goes out in output order, and the reply carries none. */
function attachedWithScreen(screen: string) {
  return async (args: { ptyId: string; replayInStream?: boolean }) => {
    if (!args.replayInStream) {
      return { status: 'attached', replay: screen, acquisitionId: 1 }
    }
    bridge.replay.forEach((listener) => listener({ ptyId: args.ptyId, replay: screen }))
    return { status: 'attached', replay: '', acquisitionId: 1 }
  }
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
  publishPanes([])
})

afterEach(async () => {
  await Promise.all(created.splice(0).map((transport) => transport.destroy?.()))
})

describe('a runtime pane bridged to an older relay’s terminal', () => {
  it('finds a pane mirrored from the managed server by its host tab and leaf', () => {
    publishPanes([
      { ptyId: PTY, targetId: 'ssh-box', tabId: 'tab-1', leafId: 'leaf-1', state: 'live' }
    ])
    const mirrored = `web-terminal-${encodeURIComponent('tab-1::leaf-1')}`
    expect(legacyRelayBridgePtyIdForPane({ tabId: mirrored, leafId: 'x', boundPtyId: null })).toBe(
      PTY
    )
    const other = `web-terminal-${encodeURIComponent('tab-1::leaf-2')}`
    expect(
      legacyRelayBridgePtyIdForPane({ tabId: other, leafId: 'x', boundPtyId: null })
    ).toBeNull()
  })

  it('never lets a second pane, such as a later split, drive the same old shell', () => {
    publishPanes([{ ptyId: PTY, targetId: 'ssh-box', tabId: 'tab-7', state: 'live' }])
    const mirrored = `web-terminal-${encodeURIComponent('tab-7::leaf-a')}`
    expect(legacyRelayBridgePtyIdForPane({ tabId: mirrored, leafId: 'p1', boundPtyId: null })).toBe(
      PTY
    )
    // The same pane remounting keeps it; another pane in that tab gets its own shell.
    expect(legacyRelayBridgePtyIdForPane({ tabId: mirrored, leafId: 'p1', boundPtyId: null })).toBe(
      PTY
    )
    expect(
      legacyRelayBridgePtyIdForPane({ tabId: mirrored, leafId: 'p2', boundPtyId: null })
    ).toBeNull()
  })

  it('finds the pane main serves for its tab and leaf, or the ssh id it still names', () => {
    publishPanes([
      { ptyId: PTY, targetId: 'ssh-box', tabId: 'tab-1', leafId: 'leaf-1', state: 'live' }
    ])
    expect(
      legacyRelayBridgePtyIdForPane({ tabId: 'tab-1', leafId: 'leaf-1', boundPtyId: null })
    ).toBe(PTY)
    expect(
      legacyRelayBridgePtyIdForPane({ tabId: 'tab-1', leafId: 'leaf-2', boundPtyId: null })
    ).toBeNull()
    expect(
      legacyRelayBridgePtyIdForPane({
        tabId: 'tab-9',
        leafId: 'leaf-9',
        boundPtyId: 'ssh:other@@pty-7'
      })
    ).toBe('ssh:other@@pty-7')
    expect(
      legacyRelayBridgePtyIdForPane({
        tabId: 'tab-9',
        leafId: 'leaf-9',
        boundPtyId: 'remote:env@@t'
      })
    ).toBeNull()
  })

  it('reattaches with the relay’s screen, then carries input, output, size and exit', async () => {
    bridge.attach.mockResolvedValue({ status: 'attached', replay: 'SCREEN', acquisitionId: 1 })
    const inner = innerTransport()
    const transport = createLegacyRelayBridgeTransport(PTY, inner)
    const cb = callbacks()
    await expect(transport.connect({ url: '', sessionId: PTY, callbacks: cb })).resolves.toEqual({
      id: PTY,
      isReattach: true,
      replay: 'SCREEN'
    })
    expect(transport.getPtyId()).toBe(PTY)
    expect(transport.sendInput('ls\r', 'driving')).toBe(true)
    expect(bridge.write).toHaveBeenCalledWith({ ptyId: PTY, data: 'ls\r' })
    transport.resize(100, 30)
    expect(bridge.resize).toHaveBeenCalledWith({ ptyId: PTY, cols: 100, rows: 30 })
    bridge.data.forEach((listener) => listener({ ptyId: PTY, data: 'out' }))
    bridge.data.forEach((listener) => listener({ ptyId: 'ssh:ssh-box@@pty-2', data: 'other' }))
    expect(cb.onData.mock.calls).toEqual([['out']])
    bridge.exit.forEach((listener) => listener({ ptyId: PTY, code: 0 }))
    expect(cb.onExit).toHaveBeenCalledWith(0)
    expect(bridge.detach).toHaveBeenCalledWith({ ptyId: PTY, acquisitionId: 1 })
    expect(inner.connect).not.toHaveBeenCalled()
  })

  it('asks main to hold a hidden pane’s output, and repaints from the screen main re-read', async () => {
    bridge.attach.mockResolvedValueOnce({ status: 'attached', replay: 'SCREEN', acquisitionId: 1 })
    const inner = innerTransport()
    inner.setOutputPaused = vi.fn(() => true)
    const transport = createLegacyRelayBridgeTransport(PTY, inner)
    const cb = callbacks()
    await transport.connect({ url: '', sessionId: PTY, callbacks: cb })
    expect(transport.setOutputPaused?.(true)).toBe(true)
    expect(bridge.setOutputPaused).toHaveBeenLastCalledWith({ ptyId: PTY, paused: true })
    transport.setOutputPaused?.(false)
    expect(bridge.setOutputPaused).toHaveBeenLastCalledWith({ ptyId: PTY, paused: false })
    bridge.replay.forEach((listener) => listener({ ptyId: 'ssh:ssh-box@@pty-2', replay: 'OTHER' }))
    bridge.replay.forEach((listener) => listener({ ptyId: PTY, replay: 'FRESH' }))
    expect(cb.onReplayData.mock.calls).toEqual([['FRESH', { clearBeforeReplay: true }]])
    expect(inner.setOutputPaused).not.toHaveBeenCalled()
  })

  it('reports a terminal the relay no longer runs as an expired session, then spawns on orcad', async () => {
    bridge.attach.mockResolvedValue({ status: 'exited' })
    const inner = innerTransport()
    const transport = createLegacyRelayBridgeTransport(PTY, inner)
    const cb = callbacks()
    await expect(transport.connect({ url: '', sessionId: PTY, callbacks: cb })).resolves.toBe(
      undefined
    )
    expect(cb.onError.mock.calls[0][0]).toContain('SSH_SESSION_EXPIRED')
    await transport.connect({ url: '', callbacks: cb })
    expect(inner.connect).toHaveBeenCalledTimes(1)
    expect(transport.getPtyId()).toBe('remote:env-1@@t-1')
  })

  it('keeps an unreachable terminal bound and reattaches once the relay answers', async () => {
    bridge.attach.mockResolvedValueOnce({ status: 'unverifiable' })
    const transport = createLegacyRelayBridgeTransport(PTY, innerTransport())
    const cb = callbacks()
    await expect(transport.connect({ url: '', sessionId: PTY, callbacks: cb })).resolves.toEqual({
      id: PTY,
      isReattach: true,
      replay: ''
    })
    expect(cb.onError).toHaveBeenCalledTimes(1)
    expect(cb.onExit).not.toHaveBeenCalled()
    bridge.attach.mockImplementationOnce(attachedWithScreen('BACK'))
    publishPanes([{ ptyId: PTY, targetId: 'ssh-box', tabId: 'tab-1', state: 'live' }])
    await vi.waitFor(() =>
      expect(cb.onReplayData).toHaveBeenCalledWith('BACK', { clearBeforeReplay: true })
    )
    expect(cb.onErrorCleared).toHaveBeenCalledTimes(1)
  })

  it('reattaches after a disconnect hung the bridge up, so the pane is never left deaf', async () => {
    bridge.attach.mockResolvedValueOnce({ status: 'attached', replay: 'SCREEN', acquisitionId: 1 })
    const transport = createLegacyRelayBridgeTransport(PTY, innerTransport())
    const cb = callbacks()
    await transport.connect({ url: '', sessionId: PTY, callbacks: cb })
    const live: LegacyRelayBridgedPane = {
      ptyId: PTY,
      targetId: 'ssh-box',
      tabId: 'tab-1',
      state: 'live'
    }
    publishPanes([live])
    // A disconnect stops the bridge, which publishes no panes and reports no exit.
    bridge.attach.mockResolvedValueOnce({ status: 'unverifiable' })
    publishPanes([])
    await vi.waitFor(() => expect(bridge.attach).toHaveBeenCalledTimes(2))
    expect(transport.sendInput('lost\r', 'driving')).toBe(false)
    expect(cb.onExit).not.toHaveBeenCalled()
    // Main's new bridge forwards output only to a pane that attached to it.
    bridge.attach.mockImplementationOnce(attachedWithScreen('BACK'))
    publishPanes([live])
    await vi.waitFor(() =>
      expect(cb.onReplayData).toHaveBeenCalledWith('BACK', { clearBeforeReplay: true })
    )
    expect(transport.sendInput('ls\r', 'driving')).toBe(true)
  })

  it('asks again for a pane that turned live while an earlier ask was still out', async () => {
    bridge.attach.mockResolvedValueOnce({ status: 'attached', replay: 'SCREEN', acquisitionId: 1 })
    const transport = createLegacyRelayBridgeTransport(PTY, innerTransport())
    const cb = callbacks()
    await transport.connect({ url: '', sessionId: PTY, callbacks: cb })
    let answerFirst: (result: { status: 'unverifiable' }) => void = () => {}
    bridge.attach.mockReturnValueOnce(new Promise((resolve) => (answerFirst = resolve)))
    publishPanes([])
    await vi.waitFor(() => expect(bridge.attach).toHaveBeenCalledTimes(2))
    // The replacement bridge lists the pane live before the ask its predecessor took answers.
    publishPanes([{ ptyId: PTY, targetId: 'ssh-box', tabId: 'tab-1', state: 'live' }])
    bridge.attach.mockImplementationOnce(attachedWithScreen('BACK'))
    answerFirst({ status: 'unverifiable' })
    await vi.waitFor(() =>
      expect(cb.onReplayData).toHaveBeenCalledWith('BACK', { clearBeforeReplay: true })
    )
    expect(transport.isConnected()).toBe(true)
  })

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

  it('hands back an attach that answers after its pane left', async () => {
    let answer: (result: unknown) => void = () => {}
    bridge.attach.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    const transport = createLegacyRelayBridgeTransport(PTY, innerTransport())
    const cb = callbacks()
    const connecting = transport.connect({ url: '', sessionId: PTY, callbacks: cb })
    transport.detach?.()
    answer({ status: 'attached', replay: 'SCREEN', acquisitionId: 9 })
    await expect(connecting).resolves.toBeUndefined()
    expect(bridge.detach).toHaveBeenCalledWith({ ptyId: PTY, acquisitionId: 9 })
    expect(transport.isConnected()).toBe(false)
    expect(cb.onConnect).not.toHaveBeenCalled()
  })

  it('hands back a reattach that answers after its pane was closed', async () => {
    bridge.attach.mockResolvedValueOnce({ status: 'unverifiable' })
    const transport = createLegacyRelayBridgeTransport(PTY, innerTransport())
    const cb = callbacks()
    await transport.connect({ url: '', sessionId: PTY, callbacks: cb })
    let answer: (result: unknown) => void = () => {}
    bridge.attach.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    publishPanes([{ ptyId: PTY, targetId: 'ssh-box', tabId: 'tab-1', state: 'live' }])
    await vi.waitFor(() => expect(bridge.attach).toHaveBeenCalledTimes(2))
    transport.destroy?.()
    answer({ status: 'attached', replay: '', acquisitionId: 9 })
    await vi.waitFor(() =>
      expect(bridge.detach).toHaveBeenCalledWith({ ptyId: PTY, acquisitionId: 9 })
    )
    expect(cb.onErrorCleared).not.toHaveBeenCalled()
  })

  it('ends a pane it was still waiting on once the relay proves the terminal gone', async () => {
    bridge.attach.mockResolvedValueOnce({ status: 'unverifiable' })
    const transport = createLegacyRelayBridgeTransport(PTY, innerTransport())
    const cb = callbacks()
    await transport.connect({ url: '', sessionId: PTY, callbacks: cb })
    bridge.attach.mockResolvedValueOnce({ status: 'exited' })
    publishPanes([])
    await vi.waitFor(() => expect(cb.onExit).toHaveBeenCalledWith(-1))
  })

  it('stops the old shell when its pane is closed, and never when it is only detached', async () => {
    bridge.attach.mockResolvedValue({ status: 'attached', replay: '', acquisitionId: 1 })
    const detached = createLegacyRelayBridgeTransport(PTY, innerTransport())
    await detached.connect({ url: '', sessionId: PTY, callbacks: callbacks() })
    detached.detach?.()
    expect(bridge.close).not.toHaveBeenCalled()
    const closed = createLegacyRelayBridgeTransport(PTY, innerTransport())
    await closed.connect({ url: '', sessionId: PTY, callbacks: callbacks() })
    closed.destroy?.()
    expect(bridge.close).toHaveBeenCalledWith({ ptyId: PTY })
  })

  it('names the bridged shells a closing tab runs, or only its leaf for a split mirror', () => {
    const second = 'ssh:ssh-box@@pty-2'
    publishPanes([
      { ptyId: PTY, targetId: 'ssh-box', tabId: 'tab-1', leafId: 'leaf-1', state: 'live' },
      {
        ptyId: second,
        targetId: 'ssh-box',
        tabId: 'tab-1',
        leafId: 'leaf-2',
        state: 'unverifiable'
      },
      { ptyId: 'ssh:ssh-box@@pty-3', targetId: 'ssh-box', tabId: 'tab-2', state: 'live' }
    ])
    expect(legacyRelayBridgedPtyIdsForClosingTab('web-terminal-tab-1', [])).toEqual([PTY, second])
    const leaf = `web-terminal-${encodeURIComponent('tab-1::leaf-2')}`
    expect(legacyRelayBridgedPtyIdsForClosingTab(leaf, [])).toEqual([second])
    // A tab still bound to a bridged shell names it even under another id; others are ignored.
    expect(
      legacyRelayBridgedPtyIdsForClosingTab('local-tab', ['ssh:ssh-box@@pty-3', 'pty-local'])
    ).toEqual(['ssh:ssh-box@@pty-3'])
  })

  it('hands any other connect straight to the managed server’s transport', async () => {
    const inner = innerTransport()
    const transport = createLegacyRelayBridgeTransport(PTY, inner)
    await transport.connect({ url: '', sessionId: 'remote:env-1@@t-1', callbacks: callbacks() })
    expect(bridge.attach).not.toHaveBeenCalled()
    expect(inner.connect).toHaveBeenCalledTimes(1)
  })
})
