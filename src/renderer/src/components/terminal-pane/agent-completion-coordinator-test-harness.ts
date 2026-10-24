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

export function processResult(
  foregroundProcess: string | null,
  hasChildProcesses = foregroundProcess !== null
): RuntimeTerminalProcessInspection {
  return {
    foregroundProcess,
    hasChildProcesses,
    childProcessEvidence: hasChildProcesses ? 'children' : 'no-children'
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

export function ambiguousLocalProcessResult(): RuntimeTerminalProcessInspection {
  return {
    foregroundProcess: null,
    hasChildProcesses: true,
    childProcessEvidence: 'children',
    foregroundProcessEvidence: {
      verdict: 'live',
      processName: null,
      authorityGeneration: 'gen-1',
      observationEpoch: 1,
      capturedAgeMs: 0,
      ptyId: 'pty-1',
      ptyIncarnationId: 'inc-1',
      fence: {
        platform: 'posix',
        shellPid: 100,
        shellStartTime: '100',
        tty: 'ttys004',
        foregroundPgid: 100
      }
    }
  }
}
