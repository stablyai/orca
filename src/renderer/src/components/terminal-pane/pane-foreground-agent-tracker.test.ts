// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPaneForegroundAgentTracker } from './pane-foreground-agent-tracker'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'

const COMMAND_SETTLE_MS = 350
const VISIBLE_PTY_SETTLE_MS = 350
const WRAPPER_RESOLVE_RETRY_MS = 1200
const SECOND_WRAPPER_RETRY_MS = 3500

describe('createPaneForegroundAgentTracker', () => {
  const readForegroundProcess = vi.fn<(ptyId: string) => Promise<string | null>>()
  const publish = vi.fn<(entry: PaneForegroundAgentEntry) => void>()
  const onConfirmedShellForeground = vi.fn<() => void>()
  let ptyId: string | null = 'pty-1'

  function makeTracker(): ReturnType<typeof createPaneForegroundAgentTracker> {
    return createPaneForegroundAgentTracker({
      getPtyId: () => ptyId,
      isTrackablePtyId: (id) => !id.startsWith('remote:') && !id.startsWith('ssh:'),
      readForegroundProcess,
      publish,
      onConfirmedShellForeground
    })
  }

  async function flushSettleRead(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    readForegroundProcess.mockReset()
    publish.mockReset()
    onConfirmedShellForeground.mockReset()
    ptyId = 'pty-1'
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('reads the foreground once after a command starts and publishes the recognized agent', async () => {
    readForegroundProcess.mockResolvedValue('claude')
    const tracker = makeTracker()

    tracker.onCommandStarted()
    expect(publish).toHaveBeenCalledExactlyOnceWith({ agent: null, shellForeground: false })
    expect(readForegroundProcess).not.toHaveBeenCalled()

    await flushSettleRead(COMMAND_SETTLE_MS)

    expect(readForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(publish).toHaveBeenLastCalledWith({ agent: 'claude', shellForeground: false })
  })

  it('reads the foreground for a visible PTY so restored running Codex panes regain identity', async () => {
    readForegroundProcess.mockResolvedValue('codex')
    const tracker = makeTracker()

    tracker.onVisiblePtyBound()
    expect(readForegroundProcess).not.toHaveBeenCalled()

    await flushSettleRead(VISIBLE_PTY_SETTLE_MS)

    expect(readForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(publish).toHaveBeenLastCalledWith({ agent: 'codex', shellForeground: false })
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
    expect(publish).toHaveBeenLastCalledWith({ agent: 'codex', shellForeground: false })
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
    expect(publish).toHaveBeenLastCalledWith({ agent: 'codex', shellForeground: false })
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
    expect(publish).toHaveBeenLastCalledWith({ agent: 'codex', shellForeground: false })
  })

  it('re-reads on a bounded ladder while the read still sees an interpreter wrapper', async () => {
    // Why: daemon shell/helper→agent ancestry resolution has been observed to
    // take >1.5s for real node-wrapped CLIs, so the ladder gets two re-reads.
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
    expect(publish).toHaveBeenLastCalledWith({ agent: 'claude', shellForeground: false })
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
    // Why: 133;D cancels pending reads, so a read that still runs means the
    // command is live — a shell foreground here is a nested sh/bash, and a
    // shell-foreground mark would suppress live title identity in the pane.
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

    expect(publish).toHaveBeenLastCalledWith({ agent: 'gemini', shellForeground: false })
  })

  it('marks shell foreground on command finished without any foreground read', () => {
    const tracker = makeTracker()

    tracker.onCommandFinished()

    expect(publish).toHaveBeenCalledExactlyOnceWith({ agent: null, shellForeground: true })
    expect(readForegroundProcess).not.toHaveBeenCalled()
  })

  it('confirms a rapid command start->finish instead of trusting the D', async () => {
    // Why: a leaked nested-shell 133;C->133;D pair (or a fast real command)
    // cancels the command-start read; confirm the foreground so a still-running
    // manual agent with no launchAgent/hook keeps its identity.
    readForegroundProcess.mockResolvedValue('claude')
    const tracker = makeTracker()

    tracker.onCommandStarted()
    tracker.onCommandFinished()
    await flushSettleRead(COMMAND_SETTLE_MS)

    expect(readForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(publish).toHaveBeenLastCalledWith({ agent: 'claude', shellForeground: false })
    expect(publish).not.toHaveBeenCalledWith({ agent: null, shellForeground: true })
  })

  it('confirms duplicate 133;D pairs instead of fast-pathing past the pending confirmation', async () => {
    // Why: user shell integrations (iTerm/VS Code) double up Orca's OSC 133, so
    // every D arrives twice ~50ms apart. The second D cancels the first D's
    // confirming read; it must reschedule the confirmation, not trust the D.
    readForegroundProcess.mockResolvedValue('grok')
    const tracker = makeTracker()

    tracker.onCommandStarted()
    tracker.onCommandStarted()
    tracker.onCommandFinished()
    await flushSettleRead(50)
    tracker.onCommandFinished()
    await flushSettleRead(COMMAND_SETTLE_MS)

    expect(readForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(publish).toHaveBeenLastCalledWith({ agent: 'grok', shellForeground: false })
    expect(publish).not.toHaveBeenCalledWith({ agent: null, shellForeground: true })
  })

  it('still marks shell without a read for a duplicate D pair on an idle pane', async () => {
    const tracker = makeTracker()

    tracker.onCommandFinished()
    await flushSettleRead(50)
    tracker.onCommandFinished()
    await flushSettleRead(COMMAND_SETTLE_MS)

    // Why: with no command read in flight the first D takes the no-RPC path,
    // so its duplicate has nothing to re-confirm and stays RPC-free too.
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

    expect(readForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(publish).toHaveBeenLastCalledWith({ agent: null, shellForeground: true })
  })

  it('confirms the foreground before clearing a pane an agent has owned', async () => {
    readForegroundProcess.mockResolvedValue('codex')
    const tracker = makeTracker()

    tracker.onCommandStarted()
    await flushSettleRead(COMMAND_SETTLE_MS)
    expect(publish).toHaveBeenLastCalledWith({ agent: 'codex', shellForeground: false })

    publish.mockClear()
    readForegroundProcess.mockClear()
    tracker.onCommandFinished()
    // Why: a leaked nested-shell 133;D must not clear Codex before the read.
    expect(publish).not.toHaveBeenCalled()

    await flushSettleRead(COMMAND_SETTLE_MS)
    expect(readForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(publish).toHaveBeenLastCalledWith({ agent: 'codex', shellForeground: false })
    expect(publish).not.toHaveBeenCalledWith({ agent: null, shellForeground: true })
  })

  it('marks shell foreground when the confirming read shows the agent is gone', async () => {
    readForegroundProcess.mockResolvedValueOnce('codex').mockResolvedValueOnce('zsh')
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
    // Reads: command-start=codex, first finish=codex (still running), second finish=zsh (exited).
    readForegroundProcess
      .mockResolvedValueOnce('codex')
      .mockResolvedValueOnce('codex')
      .mockResolvedValueOnce('zsh')
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
    readForegroundProcess.mockResolvedValueOnce('codex').mockResolvedValueOnce('zsh')
    const tracker = makeTracker()

    tracker.onCommandStarted()
    await flushSettleRead(COMMAND_SETTLE_MS)
    tracker.onCommandFinished()
    await flushSettleRead(COMMAND_SETTLE_MS)

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
      publish,
      hasKnownAgentIdentity: () => true
    })

    tracker.onCommandFinished()
    // Why: launchAgent/hook identity means the 133;D is confirmed, not trusted.
    expect(publish).not.toHaveBeenCalled()

    await flushSettleRead(COMMAND_SETTLE_MS)
    expect(readForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(publish).toHaveBeenLastCalledWith({ agent: 'codex', shellForeground: false })
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

    expect(publish).toHaveBeenLastCalledWith({ agent: 'codex', shellForeground: false })
    expect(publish).not.toHaveBeenCalledWith({ agent: 'claude', shellForeground: false })
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
