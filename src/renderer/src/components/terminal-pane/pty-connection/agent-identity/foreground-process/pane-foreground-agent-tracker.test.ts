// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPaneForegroundAgentTracker } from './pane-foreground-agent-tracker'
import type { PaneForegroundAgentEntry } from '@/store/slices/agent-status/pane-foreground-agent'

const COMMAND_SETTLE_MS = 350
const VISIBLE_PTY_SETTLE_MS = 350
const WRAPPER_RESOLVE_RETRY_MS = 1200
const SECOND_WRAPPER_RETRY_MS = 6000

describe('createPaneForegroundAgentTracker', () => {
  const readForegroundProcess = vi.fn<(ptyId: string) => Promise<string | null>>()
  const confirmForegroundProcess = vi.fn<(ptyId: string) => Promise<string | null>>()
  const publish = vi.fn<(entry: PaneForegroundAgentEntry) => void>()
  const onConfirmedShellForeground = vi.fn<() => void>()
  const onCommandFinishedUnavailable = vi.fn<() => void>()
  const onVisibleForegroundSettled = vi.fn<(outcome: 'agent' | 'shell' | 'inconclusive') => void>()
  let ptyId: string | null = 'pty-1'

  function makeTracker(
    hasKnownAgentIdentity?: () => boolean
  ): ReturnType<typeof createPaneForegroundAgentTracker> {
    return createPaneForegroundAgentTracker({
      getPtyId: () => ptyId,
      isTrackablePtyId: (id) => !id.startsWith('remote:') && !id.startsWith('ssh:'),
      readForegroundProcess,
      confirmForegroundProcess,
      publish,
      hasKnownAgentIdentity,
      onConfirmedShellForeground,
      onCommandFinishedUnavailable,
      onVisibleForegroundSettled
    })
  }

  async function flushSettleRead(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    readForegroundProcess.mockReset()
    confirmForegroundProcess.mockReset()
    confirmForegroundProcess.mockImplementation((id) => readForegroundProcess(id))
    publish.mockReset()
    onConfirmedShellForeground.mockReset()
    onCommandFinishedUnavailable.mockReset()
    onVisibleForegroundSettled.mockReset()
    ptyId = 'pty-1'
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  // Abandoned reads publish nothing, so they must release capabilities with no successor to settle them.
  it('settles the visible confirmation when a pty rebind abandons its read', async () => {
    let resolveRead: (value: string | null) => void = () => {}
    readForegroundProcess.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          resolveRead = resolve
        })
    )
    const tracker = makeTracker()

    tracker.onVisiblePtyBound(true)
    await flushSettleRead(VISIBLE_PTY_SETTLE_MS)

    // The pane is rebound to a different PTY while the inspection RPC is in flight.
    ptyId = 'pty-2'
    resolveRead('pi')
    await flushSettleRead(1)

    expect(publish).not.toHaveBeenCalled()
    expect(onVisibleForegroundSettled).toHaveBeenCalledWith('inconclusive')
  })

  // A replacement read that publishes nothing must still settle the visible confirmation it cancelled.
  it('settles the visible confirmation when a command-finished read still sees the agent', async () => {
    readForegroundProcess.mockResolvedValue('claude')
    const tracker = makeTracker()

    tracker.onCommandStarted()
    await flushSettleRead(COMMAND_SETTLE_MS)
    onVisibleForegroundSettled.mockReset()

    // A leaked 133;D cancels the visible read and replaces it with this one.
    tracker.onVisiblePtyBound(true)
    tracker.onCommandFinished()
    readForegroundProcess.mockResolvedValue('git')
    await flushSettleRead(COMMAND_SETTLE_MS)

    expect(onVisibleForegroundSettled).toHaveBeenCalledWith('inconclusive')
  })

  it('drops a delayed foreground result after the pane rebinds to another PTY', async () => {
    let resolveRead!: (processName: string) => void
    readForegroundProcess.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveRead = resolve
      })
    )
    const tracker = makeTracker()

    tracker.onCommandStarted()
    await flushSettleRead(COMMAND_SETTLE_MS)
    expect(readForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    ptyId = 'pty-2'
    resolveRead('droid')
    await Promise.resolve()
    await Promise.resolve()

    expect(publish).not.toHaveBeenCalledWith({
      agent: 'droid',
      agentEvidence: 'process-read',
      shellForeground: false
    })
  })

  it('uses typed-agent text only to await process confirmation', async () => {
    readForegroundProcess.mockResolvedValueOnce('powershell.exe').mockResolvedValueOnce('droid')
    const tracker = makeTracker()

    tracker.onCommandStarted('droid')
    expect(publish).toHaveBeenCalledExactlyOnceWith({ agent: null, shellForeground: false })

    await flushSettleRead(COMMAND_SETTLE_MS)
    expect(publish).toHaveBeenCalledTimes(1)
    await flushSettleRead(WRAPPER_RESOLVE_RETRY_MS)
    expect(publish).toHaveBeenLastCalledWith({
      agent: 'droid',
      agentEvidence: 'process-read',
      routingTrusted: true,
      shellForeground: false
    })
  })

  it('never publishes typed Droid when command-start reads stay unavailable', async () => {
    readForegroundProcess.mockResolvedValue(null)
    const tracker = makeTracker()

    tracker.onCommandStarted('droid')
    await flushSettleRead(COMMAND_SETTLE_MS)
    expect(publish).toHaveBeenLastCalledWith({ agent: null, shellForeground: false })

    await flushSettleRead(WRAPPER_RESOLVE_RETRY_MS)
    expect(publish).toHaveBeenLastCalledWith({ agent: null, shellForeground: false })

    await flushSettleRead(SECOND_WRAPPER_RETRY_MS - 1)
    expect(publish).toHaveBeenLastCalledWith({ agent: null, shellForeground: false })
    await flushSettleRead(1)

    expect(readForegroundProcess).toHaveBeenCalledTimes(3)
    expect(publish).toHaveBeenLastCalledWith({ agent: null, shellForeground: false })
  })

  it('lets command-start sampling supersede a pending visible PTY read', async () => {
    readForegroundProcess.mockResolvedValue('codex')
    const tracker = makeTracker()

    tracker.onVisiblePtyBound()
    tracker.onCommandStarted()
    await flushSettleRead(VISIBLE_PTY_SETTLE_MS)

    expect(readForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(publish).toHaveBeenLastCalledWith({
      agent: 'codex',
      agentEvidence: 'process-read',
      shellForeground: false
    })
  })

  it('does not let visible PTY sampling downgrade pending command-start sampling', async () => {
    readForegroundProcess.mockResolvedValueOnce('bash').mockResolvedValueOnce('codex')
    const tracker = makeTracker()

    tracker.onCommandStarted()
    tracker.onVisiblePtyBound()
    await flushSettleRead(COMMAND_SETTLE_MS)
    expect(readForegroundProcess).toHaveBeenCalledTimes(1)

    await flushSettleRead(WRAPPER_RESOLVE_RETRY_MS)
    expect(readForegroundProcess).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenLastCalledWith({
      agent: 'codex',
      agentEvidence: 'process-read',
      shellForeground: false
    })
  })

  it('re-reads on a bounded ladder while the read still sees an interpreter wrapper', async () => {
    // Two retries cover observed node-wrapper ancestry enrichment beyond 1.5s.
    readForegroundProcess
      .mockResolvedValueOnce('node')
      .mockResolvedValueOnce('node')
      .mockResolvedValueOnce('claude')
    const tracker = makeTracker()

    tracker.onCommandStarted()
    await flushSettleRead(COMMAND_SETTLE_MS)
    expect(readForegroundProcess).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith({ agent: null, shellForeground: false })

    await flushSettleRead(WRAPPER_RESOLVE_RETRY_MS)
    expect(readForegroundProcess).toHaveBeenCalledTimes(2)

    await flushSettleRead(SECOND_WRAPPER_RETRY_MS)
    expect(readForegroundProcess).toHaveBeenCalledTimes(3)
    expect(publish).toHaveBeenLastCalledWith({
      agent: 'claude',
      agentEvidence: 'process-read',
      shellForeground: false
    })
  })

  it('keeps duplicate ordinary 133;D pairs on the no-scan shell path', async () => {
    readForegroundProcess.mockResolvedValue('grok')
    const tracker = makeTracker()

    tracker.onCommandStarted()
    tracker.onCommandStarted()
    tracker.onCommandFinished()
    await flushSettleRead(50)
    tracker.onCommandFinished()
    await flushSettleRead(COMMAND_SETTLE_MS)

    expect(readForegroundProcess).not.toHaveBeenCalled()
    expect(publish).toHaveBeenLastCalledWith({ agent: null, shellForeground: true })
  })

  it('confirms the foreground before clearing a pane an agent has owned', async () => {
    readForegroundProcess.mockResolvedValue('codex')
    const tracker = makeTracker()

    tracker.onCommandStarted()
    await flushSettleRead(COMMAND_SETTLE_MS)
    expect(publish).toHaveBeenLastCalledWith({
      agent: 'codex',
      agentEvidence: 'process-read',
      shellForeground: false
    })

    publish.mockClear()
    readForegroundProcess.mockClear()
    tracker.onCommandFinished()
    // Why: a leaked nested-shell 133;D must not clear Codex before the read.
    expect(publish).not.toHaveBeenCalled()

    await flushSettleRead(COMMAND_SETTLE_MS)
    expect(readForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(publish).toHaveBeenLastCalledWith({
      agent: 'codex',
      agentEvidence: 'process-read',
      routingTrusted: true,
      shellForeground: false
    })
    expect(publish).not.toHaveBeenCalledWith({ agent: null, shellForeground: true })
  })

  it('signals confirmed shell foreground only when the read proves the agent exited', async () => {
    // Reads: command-start=codex, first finish=codex (still running), then a
    // bounded zsh→zsh→zsh confirmation for genuine exit.
    readForegroundProcess
      .mockResolvedValueOnce('codex')
      .mockResolvedValueOnce('codex')
      .mockResolvedValue('zsh')
    const tracker = makeTracker()

    tracker.onCommandStarted()
    await flushSettleRead(COMMAND_SETTLE_MS)

    // A leaked nested-shell 133;D while Codex still owns the foreground: no signal.
    tracker.onCommandFinished()
    await flushSettleRead(COMMAND_SETTLE_MS)
    expect(onConfirmedShellForeground).not.toHaveBeenCalled()

    // Genuine exit -> read sees a shell -> signal fires exactly once.
    tracker.onCommandFinished()
    await flushSettleRead(COMMAND_SETTLE_MS)
    expect(onConfirmedShellForeground).toHaveBeenCalledTimes(1)
  })

  it('returns to the no-RPC finished path after the agent is confirmed gone', async () => {
    readForegroundProcess.mockResolvedValueOnce('codex').mockResolvedValue('zsh')
    const tracker = makeTracker()

    tracker.onCommandStarted()
    await flushSettleRead(COMMAND_SETTLE_MS)
    tracker.onCommandFinished()
    await flushSettleRead(COMMAND_SETTLE_MS)
    await flushSettleRead(WRAPPER_RESOLVE_RETRY_MS)
    await flushSettleRead(SECOND_WRAPPER_RETRY_MS)

    publish.mockClear()
    readForegroundProcess.mockClear()
    tracker.onCommandFinished()

    expect(readForegroundProcess).not.toHaveBeenCalled()
    expect(publish).toHaveBeenCalledExactlyOnceWith({ agent: null, shellForeground: true })
  })

  it('does not let removed launch identity override fresh shell evidence', async () => {
    let knownIdentity = true
    readForegroundProcess.mockResolvedValueOnce('powershell.exe').mockResolvedValueOnce('droid')
    const tracker = makeTracker(() => knownIdentity)

    tracker.onCommandFinished()
    // Launch metadata is cleared in the same 133;D callback, before the delayed confirming read.
    knownIdentity = false
    await flushSettleRead(COMMAND_SETTLE_MS)
    expect(publish).toHaveBeenCalledExactlyOnceWith({ agent: null, shellForeground: true })
  })

  it('retries a null foreground result once for a known Droid pane', async () => {
    readForegroundProcess.mockResolvedValueOnce(null).mockResolvedValueOnce('droid')
    const tracker = makeTracker(() => true)

    tracker.onCommandFinished()
    await flushSettleRead(COMMAND_SETTLE_MS)
    expect(publish).not.toHaveBeenCalled()

    await flushSettleRead(WRAPPER_RESOLVE_RETRY_MS)
    expect(readForegroundProcess).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenCalledExactlyOnceWith({
      agent: 'droid',
      agentEvidence: 'process-read',
      routingTrusted: true,
      shellForeground: false
    })
  })

  it('retries a rejected foreground read once for a known Droid pane', async () => {
    readForegroundProcess.mockRejectedValueOnce(new Error('inspection unavailable'))
    readForegroundProcess.mockResolvedValueOnce('droid')
    const tracker = makeTracker(() => true)

    tracker.onCommandFinished()
    await flushSettleRead(COMMAND_SETTLE_MS)
    expect(publish).not.toHaveBeenCalled()

    await flushSettleRead(WRAPPER_RESOLVE_RETRY_MS)
    expect(readForegroundProcess).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenCalledExactlyOnceWith({
      agent: 'droid',
      agentEvidence: 'process-read',
      routingTrusted: true,
      shellForeground: false
    })
  })

  it('retires known identity when the bounded command-finish ladder remains unavailable', async () => {
    readForegroundProcess.mockResolvedValue(null)
    const tracker = makeTracker(() => true)

    tracker.onCommandFinished()
    await flushSettleRead(COMMAND_SETTLE_MS)
    expect(publish).not.toHaveBeenCalled()

    await flushSettleRead(WRAPPER_RESOLVE_RETRY_MS)
    expect(readForegroundProcess).toHaveBeenCalledTimes(2)
    await flushSettleRead(SECOND_WRAPPER_RETRY_MS)

    expect(readForegroundProcess).toHaveBeenCalledTimes(3)
    expect(publish).toHaveBeenCalledExactlyOnceWith({ agent: null, shellForeground: false })
    expect(onConfirmedShellForeground).not.toHaveBeenCalled()
    expect(onCommandFinishedUnavailable).toHaveBeenCalledTimes(1)
  })

  it('rebuilds visible launch identity through provisional daemon shell results', async () => {
    readForegroundProcess
      .mockResolvedValueOnce('powershell.exe')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('droid')
    const tracker = makeTracker(() => false)

    tracker.onVisiblePtyBound(true)
    await flushSettleRead(VISIBLE_PTY_SETTLE_MS)
    await flushSettleRead(WRAPPER_RESOLVE_RETRY_MS)
    expect(publish).not.toHaveBeenCalled()

    await flushSettleRead(SECOND_WRAPPER_RETRY_MS)
    expect(readForegroundProcess).toHaveBeenCalledTimes(3)
    expect(publish).toHaveBeenCalledExactlyOnceWith({
      agent: 'droid',
      agentEvidence: 'process-read',
      routingTrusted: true,
      shellForeground: false
    })
  })

  it('drops a stale read result when a newer command superseded it', async () => {
    let resolveFirstRead: (value: string | null) => void = () => {}
    readForegroundProcess
      .mockImplementationOnce(
        () =>
          new Promise<string | null>((resolve) => {
            resolveFirstRead = resolve
          })
      )
      .mockResolvedValueOnce('codex')
    const tracker = makeTracker()

    tracker.onCommandStarted()
    await flushSettleRead(COMMAND_SETTLE_MS)
    tracker.onCommandStarted()
    resolveFirstRead('claude')
    await flushSettleRead(COMMAND_SETTLE_MS)

    expect(publish).toHaveBeenLastCalledWith({
      agent: 'codex',
      agentEvidence: 'process-read',
      shellForeground: false
    })
    expect(publish).not.toHaveBeenCalledWith({
      agent: 'claude',
      agentEvidence: 'process-read',
      shellForeground: false
    })
  })

  it('stops publishing after dispose', async () => {
    readForegroundProcess.mockResolvedValue('claude')
    const tracker = makeTracker()

    tracker.onCommandStarted()
    publish.mockReset()
    tracker.dispose()
    await flushSettleRead(COMMAND_SETTLE_MS + WRAPPER_RESOLVE_RETRY_MS)

    expect(readForegroundProcess).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })
})
