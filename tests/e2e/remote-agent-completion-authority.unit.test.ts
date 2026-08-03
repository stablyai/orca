import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTerminalTitleTracker } from '../../src/shared/terminal-output-side-effects'
import {
  createAgentCompletionCoordinator,
  resetAgentCompletionCoordinatorIdentitiesForTest
} from '../../src/renderer/src/components/terminal-pane/agent-completion-coordinator'
import type { AgentCompletionDispatchMeta } from '../../src/renderer/src/components/terminal-pane/agent-completion-coordinator-types'
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

  it('keeps transport loss unknown through reconnect and completes only after authoritative idle samples', async () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-remote:leaf-remote',
      getPtyId: () => REMOTE_PTY_ID,
      getSettings: () => ({ activeRuntimeEnvironmentId: 'remote-host' }),
      inspectProcess: inspectRuntimeTerminalProcess,
      dispatchCompletion,
      isLive: () => true
    })

    runtimeCall.mockResolvedValue(remoteInspection('codex'))
    coordinator.startProcessTracking()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(runtimeCall).toHaveBeenCalledTimes(1)

    runtimeCall.mockResolvedValue({
      ok: false,
      error: { code: 'terminal_handle_stale', message: 'remote transport is reconnecting' }
    })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(runtimeCall.mock.calls.length).toBeGreaterThan(2)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    runtimeCall.mockResolvedValue(remoteInspection('codex'))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    runtimeCall.mockResolvedValue(remoteInspection(null, false))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(dispatchCompletion).toHaveBeenCalledExactlyOnceWith('codex', {
      source: 'process-exit',
      quietedHookDone: false,
      terminalIdleConfirmed: true
    })

    coordinator.dispose()
  })

  it.each([
    {
      failure: {
        ok: false,
        error: { code: 'no_connected_pty', message: 'remote transport is unavailable' }
      },
      kind: 'an unavailable response'
    },
    {
      failure: new Error('Runtime request timed out before terminal.inspectProcess completed'),
      kind: 'a thrown transport failure'
    }
  ])(
    'requires two new idle samples when $kind interrupts exit confirmation',
    async ({ failure }) => {
      const dispatchCompletion = vi.fn()
      const coordinator = createAgentCompletionCoordinator({
        paneKey: 'tab-remote:leaf-partitioned-exit',
        getPtyId: () => REMOTE_PTY_ID,
        getSettings: () => ({ activeRuntimeEnvironmentId: 'remote-host' }),
        inspectProcess: inspectRuntimeTerminalProcess,
        dispatchCompletion,
        isLive: () => true
      })

      runtimeCall.mockResolvedValue(remoteInspection('codex'))
      coordinator.startProcessTracking()
      await vi.advanceTimersByTimeAsync(2_000)

      runtimeCall.mockResolvedValue(remoteInspection(null, false))
      await vi.advanceTimersByTimeAsync(750)
      expect(runtimeCall).toHaveBeenCalledTimes(2)
      expect(dispatchCompletion).not.toHaveBeenCalled()

      if (failure instanceof Error) {
        runtimeCall.mockRejectedValue(failure)
      } else {
        runtimeCall.mockResolvedValue(failure)
      }
      await vi.advanceTimersByTimeAsync(750)
      expect(runtimeCall).toHaveBeenCalledTimes(3)
      expect(dispatchCompletion).not.toHaveBeenCalled()

      runtimeCall.mockResolvedValue(remoteInspection(null, false))
      await vi.advanceTimersByTimeAsync(1_500)
      expect(runtimeCall).toHaveBeenCalledTimes(4)
      expect(dispatchCompletion).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(750)
      expect(dispatchCompletion).toHaveBeenCalledExactlyOnceWith('codex', {
        source: 'process-exit',
        quietedHookDone: false,
        terminalIdleConfirmed: true
      })

      coordinator.dispose()
    }
  )

  it('preserves distinct stopped, exited, and successful completion evidence', async () => {
    const outcomes: (
      | { kind: 'hook'; interrupted: boolean }
      | { kind: 'process-exit'; exitCode: number | null }
    )[] = []
    const createHookCoordinator = (paneKey: string) =>
      createAgentCompletionCoordinator({
        paneKey,
        getPtyId: () => REMOTE_PTY_ID,
        getSettings: () => ({ activeRuntimeEnvironmentId: 'remote-host' }),
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
