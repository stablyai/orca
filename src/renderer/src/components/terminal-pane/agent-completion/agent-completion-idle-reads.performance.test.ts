import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import type { TerminalProcessInspection } from '../../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'

// Guards #46045: foreground reads follow events, not an idle timer. Before it, every pane read every 15 s forever
// (one read per 15 s grid tick); a pane receiving input that prints nothing must never read more often than that.
const TEN_MINUTES_MS = 10 * 60_000

function startPane(result: TerminalProcessInspection) {
  const inspectProcess = vi.fn(async () => result)
  const coordinator = createAgentCompletionCoordinator({
    paneKey: 'tab-1:leaf-1',
    getPtyId: () => 'pty-1',
    inspectProcess,
    dispatchCompletion: vi.fn(),
    isLive: () => true
  })
  coordinator.startProcessTracking()
  return { coordinator, inspectProcess }
}

describe('agent completion foreground reads at rest', () => {
  beforeEach(() => {
    // Slow re-checks align to a shared 15 s wall-clock grid; a fixed start keeps the tick count exact.
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00.000Z') })
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reads once and then holds no timer for a proven idle shell and for a watched agent', async () => {
    for (const result of [
      { foregroundProcess: 'zsh', hasChildProcesses: false, idleShellProven: true as const },
      { foregroundProcess: 'codex', hasChildProcesses: true, foregroundExitWatched: true as const }
    ]) {
      const { coordinator, inspectProcess } = startPane(result)
      await vi.advanceTimersByTimeAsync(TEN_MINUTES_MS)
      expect(inspectProcess).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
      coordinator.dispose()
    }
  })

  it('never reads any pane more often than the old 15 s pace while it receives input that prints nothing', async () => {
    for (const result of [
      { foregroundProcess: 'vim', hasChildProcesses: true },
      { foregroundProcess: 'zsh', hasChildProcesses: false, idleShellProven: true as const },
      { foregroundProcess: 'codex', hasChildProcesses: true, foregroundExitWatched: true as const }
    ]) {
      const { coordinator, inspectProcess } = startPane(result)
      await vi.advanceTimersByTimeAsync(15_000)
      inspectProcess.mockClear()

      for (let elapsed = 0; elapsed < TEN_MINUTES_MS; elapsed += 3_000) {
        coordinator.observeInputActivity()
        await vi.advanceTimersByTimeAsync(3_000)
      }
      // At most one read per 15 s grid tick in these 10 minutes, as before the change.
      expect(inspectProcess.mock.calls.length).toBeLessThanOrEqual(41)
      coordinator.dispose()
    }
  })
})
