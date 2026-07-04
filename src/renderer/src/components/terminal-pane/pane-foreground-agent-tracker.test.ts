// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPaneForegroundAgentTracker } from './pane-foreground-agent-tracker'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'

const COMMAND_SETTLE_MS = 350
const WRAPPER_RESOLVE_RETRY_MS = 1200
const SECOND_WRAPPER_RETRY_MS = 3500

describe('createPaneForegroundAgentTracker', () => {
  const readForegroundProcess = vi.fn<(ptyId: string) => Promise<string | null>>()
  const publish = vi.fn<(entry: PaneForegroundAgentEntry) => void>()
  let ptyId: string | null = 'pty-1'

  function makeTracker(): ReturnType<typeof createPaneForegroundAgentTracker> {
    return createPaneForegroundAgentTracker({
      getPtyId: () => ptyId,
      isTrackablePtyId: (id) => !id.startsWith('remote:') && !id.startsWith('ssh:'),
      readForegroundProcess,
      publish
    })
  }

  async function flushSettleRead(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    readForegroundProcess.mockReset()
    publish.mockReset()
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

  it('cancels a pending read when the command finishes first', async () => {
    readForegroundProcess.mockResolvedValue('claude')
    const tracker = makeTracker()

    tracker.onCommandStarted()
    tracker.onCommandFinished()
    await flushSettleRead(COMMAND_SETTLE_MS + WRAPPER_RESOLVE_RETRY_MS)

    expect(readForegroundProcess).not.toHaveBeenCalled()
    expect(publish).toHaveBeenLastCalledWith({ agent: null, shellForeground: true })
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
