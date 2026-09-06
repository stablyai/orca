// The second consumer of the capture budget, at the point where a user feels it.
//
// A whole-machine `ps` costs seconds on a large or loaded host: 2.5-9.0s on an idle 2,002-process
// laptop, 4.0-18.6s at load 46. Publishing that as a truthful-but-late `live` record does not help
// this pane. `admitRemoteForegroundEvidence` refuses it, every refusal increments
// `consecutiveInspectionErrors`, and the poll scheduler's backoff then stretches the cadence to its
// 10s floor -- so agent-completion detection degrades on exactly the hosts where a capture is
// slowest, which are the hosts where agents take longest to finish.
//
// Giving up on the capture and publishing a prompt `unverifiable` instead costs one poll and
// nothing else: the record is admitted, so no error is counted.
import { describe, expect, it, vi } from 'vitest'
import { handleAgentCompletionInspectionResult } from './agent-completion-inspection-result'
import type { RemoteInspectionState } from './agent-completion-inspection-result'
import type { ProcessMonitorState } from './agent-completion-process-types'
import type { AgentCompletionCoordinatorOptions } from './agent-completion-coordinator-types'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { REMOTE_FOREGROUND_EVIDENCE_MAX_AGE_MS } from '../../../../shared/remote-foreground-evidence-admission'

const SSH_PTY_ID = toAppSshPtyId('target-1', 'pty-1')
const INCARNATION = 'inc-1'

function liveRecord(capturedAgeMs: number): RuntimeTerminalProcessInspection {
  return {
    foregroundProcess: 'claude',
    hasChildProcesses: true,
    foregroundProcessEvidence: {
      verdict: 'live',
      processName: 'claude',
      authorityGeneration: 'gen-1',
      observationEpoch: 1,
      capturedAgeMs,
      ptyId: 'pty-1',
      ptyIncarnationId: INCARNATION,
      fence: {
        platform: 'posix',
        shellPid: 10,
        shellStartTime: '100',
        tty: '/dev/pts/2',
        foregroundPgid: 11,
        process: { pid: 11, startTime: '101' }
      }
    }
  }
}

/** What both relay call sites publish when the capture misses its budget. */
function unreadableTableRecord(): RuntimeTerminalProcessInspection {
  return {
    foregroundProcess: 'claude',
    hasChildProcesses: true,
    foregroundProcessEvidence: {
      verdict: 'unverifiable',
      reason: 'process_table_unreadable',
      authorityGeneration: 'gen-1',
      observationEpoch: 1,
      capturedAgeMs: 0,
      ptyId: 'pty-1',
      ptyIncarnationId: INCARNATION
    }
  }
}

function inspect(result: RuntimeTerminalProcessInspection, roundTripMs = 20): ProcessMonitorState {
  const state: ProcessMonitorState = {
    disposed: false,
    inspectionInFlight: false,
    inspectionGeneration: 0,
    consecutiveInspectionErrors: 0,
    pollTrackingStarted: true,
    pollTimer: null,
    pollTimerTier: null,
    lastPaneActivityAt: null,
    hasAgentRunEvidence: false,
    pendingProcessExitAgent: null,
    lastForegroundAgent: null,
    processSession: 1
  }
  const remoteInspection: RemoteInspectionState = {
    authorityGeneration: null,
    observationEpoch: -1,
    bindingKey: null,
    knownAuthorityGenerations: new Set<string>()
  }
  const started = performance.now()
  vi.spyOn(performance, 'now').mockReturnValue(started + roundTripMs)
  handleAgentCompletionInspectionResult({
    result,
    requestStartedAtMonotonic: started,
    options: {
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => SSH_PTY_ID,
      getSettings: () => null,
      isRemotePtyId: () => true,
      getExpectedIncarnationId: () => INCARNATION
    } as unknown as AgentCompletionCoordinatorOptions,
    state,
    identityScope: {} as never,
    clearAgentRunEvidence: vi.fn(),
    hasPendingHookDone: () => false,
    hasPendingCodexAttention: () => false,
    scheduleNextPoll: vi.fn(),
    handleRecognizedProcess: vi.fn(),
    dispatchCompletion: vi.fn(),
    remoteInspection
  })
  vi.restoreAllMocks()
  return state
}

describe('agent completion polling under a host capture it cannot use', () => {
  it('counts no error for the prompt unverifiable a capture over budget produces', () => {
    expect(inspect(unreadableTableRecord()).consecutiveInspectionErrors).toBe(0)
  })

  it('counts an error for the late live record the same capture would have produced', () => {
    // One of the measured captures. Every poll refusing this way is what drives the cadence to
    // its 10s backoff floor and stops completion detection for the pane.
    expect(inspect(liveRecord(6_140)).consecutiveInspectionErrors).toBe(1)
  })

  it.each([
    ['at the ceiling', REMOTE_FOREGROUND_EVIDENCE_MAX_AGE_MS, 0],
    ['one step past it', REMOTE_FOREGROUND_EVIDENCE_MAX_AGE_MS + 1, 1]
  ])('counts %s as %s errors', (_label, capturedAgeMs, errors) => {
    expect(inspect(liveRecord(capturedAgeMs), 0).consecutiveInspectionErrors).toBe(errors)
  })

  it('admits a capture that lands inside the evidence budget', () => {
    // The reason the budget is 1,200ms rather than lower: a capture inside it must still clear the
    // 2,000ms ceiling once its duration is counted once instead of twice. Under the double count
    // this same record was refused, because 1,200 + a 1,300ms round trip read as 2,500.
    expect(inspect(liveRecord(1_200), 1_300).consecutiveInspectionErrors).toBe(0)
  })
})
