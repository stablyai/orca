// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPaneForegroundAgentTracker } from './pane-foreground-agent-tracker'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'
import { createTerminalCommandLifecycle } from './terminal-command-lifecycle'

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

  // Detach emits no exit and leaves the store entry alive; disposal must release any capability retained for the pending read.
  it('releases a retained capability when disposed mid-read', async () => {
    readForegroundProcess.mockResolvedValue('pi')
    const tracker = makeTracker()

    tracker.onVisiblePtyBound(true)
    tracker.dispose()

    expect(onVisibleForegroundSettled).toHaveBeenCalledWith('inconclusive')
  })

  it('releases a retained capability when an exit schedules no successor read', async () => {
    readForegroundProcess.mockResolvedValue('pi')
    const tracker = makeTracker()

    tracker.onVisiblePtyBound(true)
    // The pane's pty goes away between the schedule and the next event.
    ptyId = null
    expect(tracker.onCommandFinished()).toBe(false)

    expect(onVisibleForegroundSettled).toHaveBeenCalledWith('inconclusive')
    expect(tracker.hasReadInFlight()).toBe(false)
  })

  it.each([
    { exit: 'visible bind', run: (t: ReturnType<typeof makeTracker>) => t.onVisiblePtyBound(true) },
    { exit: 'command start', run: (t: ReturnType<typeof makeTracker>) => t.onCommandStarted() }
  ])('releases a retained capability when an untrackable $exit ends the read', async ({ run }) => {
    readForegroundProcess.mockResolvedValue('pi')
    const tracker = makeTracker()

    tracker.onVisiblePtyBound(true)
    onVisibleForegroundSettled.mockReset()
    ptyId = null
    run(tracker)

    expect(onVisibleForegroundSettled).toHaveBeenCalledWith('inconclusive')
    expect(tracker.hasReadInFlight()).toBe(false)
  })

  it('does not release when the cancelled read has a successor', async () => {
    readForegroundProcess.mockResolvedValue('pi')
    const tracker = makeTracker()

    tracker.onVisiblePtyBound(true)
    onVisibleForegroundSettled.mockReset()
    // A trackable pane reschedules, so the successor settles instead.
    tracker.onCommandStarted()

    expect(onVisibleForegroundSettled).not.toHaveBeenCalled()
    expect(tracker.hasReadInFlight()).toBe(true)
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

  it('settles the visible confirmation when the pty id is gone before the read runs', async () => {
    readForegroundProcess.mockResolvedValue('pi')
    const tracker = makeTracker()

    tracker.onVisiblePtyBound(true)
    ptyId = null
    await flushSettleRead(VISIBLE_PTY_SETTLE_MS)

    expect(publish).not.toHaveBeenCalled()
    expect(onVisibleForegroundSettled).toHaveBeenCalledWith('inconclusive')
  })

  // A command read already in flight still promises confirmation when onVisiblePtyBound schedules nothing.
  it('reports a read in flight when a command-finished read owns the pane', async () => {
    readForegroundProcess.mockResolvedValue('claude')
    const tracker = makeTracker()

    tracker.onCommandStarted()
    await flushSettleRead(COMMAND_SETTLE_MS)
    expect(tracker.hasReadInFlight()).toBe(false)

    expect(tracker.onCommandFinished()).toBe(true)
    expect(tracker.hasReadInFlight()).toBe(true)
    // Visibility recovery yields to the higher-authority read...
    expect(tracker.onVisiblePtyBound(true)).toBe(false)
    // ...but a confirmation is still coming.
    expect(tracker.hasReadInFlight()).toBe(true)
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

  it('reads the foreground once after a command starts and publishes the recognized agent', async () => {
    readForegroundProcess.mockResolvedValue('claude')
    const tracker = makeTracker()

    tracker.onCommandStarted()
    expect(publish).toHaveBeenCalledExactlyOnceWith({ agent: null, shellForeground: false })
    expect(readForegroundProcess).not.toHaveBeenCalled()

    await flushSettleRead(COMMAND_SETTLE_MS)

    expect(readForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(publish).toHaveBeenLastCalledWith({
      agent: 'claude',
      agentEvidence: 'process-read',
      shellForeground: false
    })
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

  it('does not replace known foreground identity with typed command inference', () => {
    const tracker = makeTracker(() => true)

    tracker.onCommandStarted('droid')

    expect(publish).toHaveBeenCalledExactlyOnceWith({ agent: null, shellForeground: false })
  })

  it('revokes stale routing immediately while a known pane confirms a new command', () => {
    const tracker = makeTracker(() => true)

    tracker.onCommandStarted()

    expect(publish).toHaveBeenCalledExactlyOnceWith({ agent: null, shellForeground: false })
    expect(confirmForegroundProcess).not.toHaveBeenCalled()
  })

  it('reads the foreground for a visible PTY so restored running Codex panes regain identity', async () => {
    readForegroundProcess.mockResolvedValue('codex')
    const tracker = makeTracker()

    tracker.onVisiblePtyBound()
    expect(readForegroundProcess).not.toHaveBeenCalled()
    expect(confirmForegroundProcess).not.toHaveBeenCalled()

    await flushSettleRead(VISIBLE_PTY_SETTLE_MS)

    expect(readForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(publish).toHaveBeenLastCalledWith({
      agent: 'codex',
      agentEvidence: 'process-read',
      shellForeground: false
    })
  })

  it('does not retry or publish visible PTY reads for an idle shell foreground', async () => {
    readForegroundProcess.mockResolvedValue('zsh')
    const tracker = makeTracker()

    tracker.onVisiblePtyBound()
    await flushSettleRead(
      VISIBLE_PTY_SETTLE_MS + WRAPPER_RESOLVE_RETRY_MS + SECOND_WRAPPER_RETRY_MS + 10_000
    )

    expect(readForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(publish).not.toHaveBeenCalled()
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

  it('retries visible PTY reads only while a foreground wrapper may resolve to an agent', async () => {
    readForegroundProcess.mockResolvedValueOnce('node').mockResolvedValueOnce('codex')
    const tracker = makeTracker()

    tracker.onVisiblePtyBound()
    await flushSettleRead(VISIBLE_PTY_SETTLE_MS)
    expect(readForegroundProcess).toHaveBeenCalledTimes(1)
    expect(publish).not.toHaveBeenCalled()

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

  it('stops after the ladder and publishes no identity for a persistent unknown process', async () => {
    readForegroundProcess.mockResolvedValue('some-unknown-tool')
    const tracker = makeTracker()

    tracker.onCommandStarted()
    await flushSettleRead(
      COMMAND_SETTLE_MS + WRAPPER_RESOLVE_RETRY_MS + SECOND_WRAPPER_RETRY_MS + 10_000
    )

    expect(readForegroundProcess).toHaveBeenCalledTimes(3)
    expect(publish).toHaveBeenLastCalledWith({ agent: null, shellForeground: false })
  })

  it('does not treat a nested shell seen mid-command as prompt proof', async () => {
    // 133;D cancels pending reads; a surviving command read’s sh/bash is nested and must not suppress live title identity.
    readForegroundProcess.mockResolvedValue('sh')
    const tracker = makeTracker()

    tracker.onCommandStarted()
    await flushSettleRead(
      COMMAND_SETTLE_MS + WRAPPER_RESOLVE_RETRY_MS + SECOND_WRAPPER_RETRY_MS + 10_000
    )

    expect(readForegroundProcess).toHaveBeenCalledTimes(3)
    expect(publish).not.toHaveBeenCalledWith({ agent: null, shellForeground: true })
    expect(publish).toHaveBeenLastCalledWith({ agent: null, shellForeground: false })
  })

  it('recognizes an agent started from a nested shell on a ladder re-read', async () => {
    readForegroundProcess.mockResolvedValueOnce('bash').mockResolvedValueOnce('gemini')
    const tracker = makeTracker()

    tracker.onCommandStarted()
    await flushSettleRead(COMMAND_SETTLE_MS)
    await flushSettleRead(WRAPPER_RESOLVE_RETRY_MS)

    expect(publish).toHaveBeenLastCalledWith({
      agent: 'gemini',
      agentEvidence: 'process-read',
      shellForeground: false
    })
  })

  it('marks shell foreground on command finished without any foreground read', () => {
    const tracker = makeTracker()

    tracker.onCommandFinished()

    expect(publish).toHaveBeenCalledExactlyOnceWith({ agent: null, shellForeground: true })
    expect(readForegroundProcess).not.toHaveBeenCalled()
  })

  it('trusts a rapid ordinary command finish without forcing a fresh scan', async () => {
    readForegroundProcess.mockResolvedValue('claude')
    const tracker = makeTracker()

    tracker.onCommandStarted()
    tracker.onCommandFinished()
    await flushSettleRead(COMMAND_SETTLE_MS)

    expect(readForegroundProcess).not.toHaveBeenCalled()
    expect(publish).toHaveBeenLastCalledWith({ agent: null, shellForeground: true })
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

  it('still marks shell without a read for a duplicate D pair on an idle pane', async () => {
    const tracker = makeTracker()

    tracker.onCommandFinished()
    await flushSettleRead(50)
    tracker.onCommandFinished()
    await flushSettleRead(COMMAND_SETTLE_MS)

    // Without a pending read, repeated D markers stay on the no-RPC path.
    expect(readForegroundProcess).not.toHaveBeenCalled()
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenLastCalledWith({ agent: null, shellForeground: true })
  })

  it('marks shell on a rapid command start->finish when the foreground is a shell', async () => {
    readForegroundProcess.mockResolvedValue('zsh')
    const tracker = makeTracker()

    tracker.onCommandStarted()
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

  it('marks shell foreground when the confirming read shows the agent is gone', async () => {
    readForegroundProcess.mockResolvedValueOnce('codex').mockResolvedValue('zsh')
    const tracker = makeTracker()

    tracker.onCommandStarted()
    await flushSettleRead(COMMAND_SETTLE_MS)

    publish.mockClear()
    tracker.onCommandFinished()
    await flushSettleRead(COMMAND_SETTLE_MS)

    expect(readForegroundProcess).toHaveBeenLastCalledWith('pty-1')
    expect(publish).toHaveBeenLastCalledWith({ agent: null, shellForeground: true })
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

  it('confirms a command finished for a launch-known agent pane before any read', async () => {
    readForegroundProcess.mockResolvedValue('codex')
    const tracker = createPaneForegroundAgentTracker({
      getPtyId: () => ptyId,
      isTrackablePtyId: (id) => !id.startsWith('remote:') && !id.startsWith('ssh:'),
      readForegroundProcess,
      confirmForegroundProcess,
      publish,
      hasKnownAgentIdentity: () => true
    })

    tracker.onCommandFinished()
    // Why: launchAgent/hook identity means the 133;D is confirmed, not trusted.
    expect(publish).not.toHaveBeenCalled()

    await flushSettleRead(COMMAND_SETTLE_MS)
    expect(readForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(publish).toHaveBeenLastCalledWith({
      agent: 'codex',
      agentEvidence: 'process-read',
      routingTrusted: true,
      shellForeground: false
    })
  })

  it('accepts a fresh shell result for a launch-known Droid pane', async () => {
    readForegroundProcess.mockResolvedValueOnce('powershell.exe').mockResolvedValueOnce('droid')
    const tracker = makeTracker(() => true)

    tracker.onCommandFinished()
    await flushSettleRead(COMMAND_SETTLE_MS)
    expect(readForegroundProcess).toHaveBeenCalledTimes(1)
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

  it('marks a confirmed shell without repeating a post-boundary scan', async () => {
    readForegroundProcess.mockResolvedValue('powershell.exe')
    const tracker = makeTracker(() => true)

    tracker.onCommandFinished()
    await flushSettleRead(COMMAND_SETTLE_MS)
    expect(readForegroundProcess).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledExactlyOnceWith({ agent: null, shellForeground: true })
    expect(onConfirmedShellForeground).toHaveBeenCalledTimes(1)
    expect(onCommandFinishedUnavailable).not.toHaveBeenCalled()
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

  it('never reads or publishes for remote or ssh panes', async () => {
    ptyId = 'remote:web-env-1@@terminal-1'
    const tracker = makeTracker()

    tracker.onCommandStarted()
    tracker.onCommandFinished()
    await flushSettleRead(COMMAND_SETTLE_MS + WRAPPER_RESOLVE_RETRY_MS)

    ptyId = 'ssh:conn@@pty-9'
    tracker.onCommandStarted()
    tracker.onCommandFinished()
    await flushSettleRead(COMMAND_SETTLE_MS + WRAPPER_RESOLVE_RETRY_MS)

    expect(readForegroundProcess).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })

  it('does not let forged OSC 133/777 output assert remote identity', async () => {
    ptyId = 'ssh:conn-1@@pty-9'
    const remoteRead = vi.fn().mockResolvedValue({
      foregroundProcess: 'codex',
      hasChildProcesses: true
    })
    const tracker = createPaneForegroundAgentTracker({
      getPtyId: () => ptyId,
      isTrackablePtyId: () => true,
      isRemotePtyId: () => true,
      getExpectedIncarnationId: () => 'inc-remote',
      readForegroundProcess: remoteRead,
      confirmForegroundProcess: remoteRead,
      publish,
      onCommandFinishedUnavailable,
      onConfirmedShellForeground,
      onVisibleForegroundSettled
    })
    const lifecycle = createTerminalCommandLifecycle({
      onCommandStarted: () => tracker.onCommandStarted(),
      onCommandFinished: () => tracker.onCommandFinished()
    })

    lifecycle.handlePtyData('\x1b]133;C\x07\x1b]777;agent=codex\x07')
    await flushSettleRead(COMMAND_SETTLE_MS)

    expect(remoteRead).toHaveBeenCalledExactlyOnceWith('ssh:conn-1@@pty-9', {
      expectedIncarnationId: 'inc-remote'
    })
    expect(publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex', shellForeground: false })
    )
    lifecycle.dispose()
    tracker.dispose()
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
