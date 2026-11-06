import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTerminalTitleTracker } from '../../src/shared/terminal/output/terminal-output-side-effects'
import { createAgentCompletionCoordinator } from '../../src/renderer/src/components/terminal-pane/agent-completion/agent-completion-coordinator'
import { resetAgentCompletionCoordinatorIdentitiesForTest } from '../../src/renderer/src/components/terminal-pane/agent-completion/agent-completion-identity-store'
import type { AgentCompletionDispatchMeta } from '../../src/renderer/src/components/terminal-pane/agent-completion/agent-completion-coordinator-types'
import { inspectRuntimeTerminalProcess } from '../../src/renderer/src/runtime/runtime-terminal-inspection'
import { clearRuntimeCompatibilityCacheForTests } from '../../src/renderer/src/runtime/runtime-rpc-client'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../src/renderer/src/runtime/runtime-compatibility-test-fixture'

const REMOTE_PTY_ID = 'remote:remote-host@@term_remote_agent'

describe('remote agent completion authority', () => {
  const runtimeCall = vi.fn()
  const runtimeTransportCall = vi.fn((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeCall(args)
  })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    clearRuntimeCompatibilityCacheForTests()
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: { call: runtimeTransportCall },
        pty: {
          getForegroundProcess: vi.fn(),
          hasChildProcesses: vi.fn()
        }
      }
    })
  })

  afterEach(() => {
    resetAgentCompletionCoordinatorIdentitiesForTest()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('keeps an idle remote pane at zero inspection cadence', async () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-remote:leaf-remote',
      getPtyId: () => REMOTE_PTY_ID,
      isRemotePtyId: () => true,
      getExpectedIncarnationId: () => 'inc-remote',
      inspectProcess: inspectRuntimeTerminalProcess,
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.startProcessTracking()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(runtimeCall).not.toHaveBeenCalled()
    expect(dispatchCompletion).not.toHaveBeenCalled()

    coordinator.dispose()
  })

  it('accepts only fenced host evidence for an explicit remote title confirmation', async () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-remote:leaf-confirm',
      getPtyId: () => REMOTE_PTY_ID,
      isRemotePtyId: () => true,
      getExpectedIncarnationId: () => 'inc-remote',
      inspectProcess: inspectRuntimeTerminalProcess,
      dispatchCompletion,
      isLive: () => true
    })

    runtimeCall.mockResolvedValue(remoteInspectionWithEvidence('codex'))
    coordinator.startProcessTracking()
    coordinator.observeTitle('Codex working')
    coordinator.observeTitle('/tmp/finished-task')
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    await Promise.resolve()

    expect(runtimeCall).toHaveBeenCalledOnce()
    expect(dispatchCompletion).toHaveBeenCalledWith('/tmp/finished-task')

    coordinator.dispose()
  })

  it('never recognizes a bare compatibility process name from an old host', async () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-remote:leaf-legacy',
      getPtyId: () => REMOTE_PTY_ID,
      isRemotePtyId: () => true,
      getExpectedIncarnationId: () => 'inc-remote',
      inspectProcess: inspectRuntimeTerminalProcess,
      dispatchCompletion,
      isLive: () => true
    })

    runtimeCall.mockResolvedValue(remoteInspection('codex'))
    coordinator.startProcessTracking()
    coordinator.observeTitle('Codex working')
    coordinator.observeTitle('/tmp/legacy-host-title')
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    await Promise.resolve()

    expect(runtimeCall).toHaveBeenCalledOnce()
    expect(dispatchCompletion).not.toHaveBeenCalled()
    coordinator.dispose()
  })

  it('dispatches process-exit only for a positive host tombstone', async () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-remote:leaf-exit',
      getPtyId: () => REMOTE_PTY_ID,
      isRemotePtyId: () => true,
      getExpectedIncarnationId: () => 'inc-remote',
      inspectProcess: inspectRuntimeTerminalProcess,
      dispatchCompletion,
      isLive: () => true
    })

    runtimeCall
      .mockResolvedValueOnce(remoteInspectionWithEvidence('codex', 1))
      .mockResolvedValueOnce(remoteInspectionWithEvidence(null, 2, 'exited'))
    coordinator.startProcessTracking()
    coordinator.observeTitle('Codex working')
    coordinator.observeTitle('/tmp/first-finish')
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    await Promise.resolve()
    dispatchCompletion.mockClear()

    coordinator.observeTitle('Codex working')
    coordinator.observeTitle('/tmp/second-finish')
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    await Promise.resolve()

    expect(dispatchCompletion).toHaveBeenCalledWith('codex', {
      source: 'process-exit',
      quietedHookDone: false,
      terminalIdleConfirmed: true
    })
    coordinator.dispose()
  })

  it('preserves distinct stopped, exited, and successful completion evidence', async () => {
    const outcomes: (
      | { kind: 'hook'; interrupted: boolean }
      | { kind: 'process-exit'; exitCode: number | null }
    )[] = []
    const createHookCoordinator = (paneKey: string) =>
      createAgentCompletionCoordinator({
        paneKey,
        getPtyId: () => REMOTE_PTY_ID,
        isRemotePtyId: () => true,
        getExpectedIncarnationId: () => 'inc-remote',
        inspectProcess: inspectRuntimeTerminalProcess,
        dispatchCompletion: (_title: string, meta?: AgentCompletionDispatchMeta) => {
          outcomes.push({
            kind: 'hook',
            interrupted: meta?.agentStatus?.interrupted === true
          })
        },
        isLive: () => true
      })

    const stopped = createHookCoordinator('tab-remote:leaf-stopped')
    stopped.observeHookStatus({ state: 'working', prompt: 'stop me', agentType: 'codex' })
    stopped.observeHookStatus({
      state: 'done',
      prompt: 'stop me',
      agentType: 'codex',
      interrupted: true
    })
    await vi.advanceTimersByTimeAsync(1_500)

    const tracker = createTerminalTitleTracker({
      onCommandFinished: (exitCode) => outcomes.push({ kind: 'process-exit', exitCode })
    })
    tracker.handleChunk('\u001b]133;D;130\u0007')

    const succeeded = createHookCoordinator('tab-remote:leaf-succeeded')
    succeeded.observeHookStatus({ state: 'working', prompt: 'finish me', agentType: 'codex' })
    succeeded.observeHookStatus({ state: 'done', prompt: 'finish me', agentType: 'codex' })
    await vi.advanceTimersByTimeAsync(1_500)

    expect(outcomes).toEqual([
      { kind: 'hook', interrupted: true },
      { kind: 'process-exit', exitCode: 130 },
      { kind: 'hook', interrupted: false }
    ])

    stopped.dispose()
    succeeded.dispose()
    tracker.dispose()
  })
})

function remoteInspection(foregroundProcess: string | null, hasChildProcesses = true) {
  return {
    ok: true,
    result: { process: { foregroundProcess, hasChildProcesses } },
    _meta: { runtimeId: 'remote-host' }
  }
}

function remoteInspectionWithEvidence(
  processName: string | null,
  observationEpoch = 1,
  verdict: 'live' | 'exited' = 'live'
) {
  return {
    ok: true,
    result: {
      process: {
        foregroundProcess: processName,
        hasChildProcesses: processName !== null,
        foregroundProcessEvidence:
          verdict === 'live'
            ? {
                verdict,
                processName,
                authorityGeneration: 'runtime-authority',
                observationEpoch,
                capturedAgeMs: 0,
                ptyId: 'term_remote_agent',
                ptyIncarnationId: 'inc-remote',
                fence: {
                  platform: 'posix' as const,
                  shellPid: 100,
                  shellStartTime: 'shell-start',
                  tty: '/dev/pts/2',
                  foregroundPgid: 101,
                  process: { pid: 101, startTime: 'agent-start' }
                }
              }
            : {
                verdict,
                reason: 'pty_exit_0',
                authorityGeneration: 'runtime-authority',
                observationEpoch,
                capturedAgeMs: 0,
                ptyId: 'term_remote_agent',
                ptyIncarnationId: 'inc-remote'
              }
      }
    },
    _meta: { runtimeId: 'remote-host' }
  }
}
