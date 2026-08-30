import { afterEach, beforeEach, vi } from 'vitest'
import { resetAgentCompletionCoordinatorIdentitiesForTest } from './agent-completion-coordinator'
import { resetAgentProcessInspectionQueueForTests } from './agent-process-inspection-queue'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'

export const HOOK_DONE_QUIET_MS = 1_500

export async function flushAsyncTicks(count = 4): Promise<void> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve()
  }
}

/** The pre-evidence collapse a host that predates `processEvidence` emits. It
 *  cannot state an absence: `zsh` + `false` is what it publishes for an idle
 *  pane AND for a foreground read that fell back to the shell title. */
export function processResult(
  foregroundProcess: string | null,
  hasChildProcesses = foregroundProcess !== null
): RuntimeTerminalProcessInspection {
  return { foregroundProcess, hasChildProcesses }
}

/** The same pane, answered by a host that PUBLISHES its verdicts — the shape a
 *  current daemon, local provider or relay emits. Use this whenever a test means
 *  "the host observed this", so an exit fixture states the exit instead of
 *  leaning on the legacy collapse. */
export function observedProcessResult(
  foregroundProcess: string | null,
  hasChildProcesses = foregroundProcess !== null
): RuntimeTerminalProcessInspection {
  return {
    foregroundProcess,
    hasChildProcesses,
    processEvidence: {
      foreground: { verdict: 'observed', processName: foregroundProcess },
      children: hasChildProcesses ? { verdict: 'live' } : { verdict: 'exited' }
    }
  }
}

export function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveDeferred!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve
  })
  return { promise, resolve: resolveDeferred }
}

// Fake timers + pinned jitter, plus the cross-coordinator identity/queue reset.
export function useAgentCompletionCoordinatorLifecycle(): void {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })

  afterEach(() => {
    resetAgentProcessInspectionQueueForTests()
    resetAgentCompletionCoordinatorIdentitiesForTest()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
}
