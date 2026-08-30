import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import * as ptyProcessProbes from '../../../src/relay/pty-process-probes'

const {
  execFileMock,
  execFileSyncMock,
  runProcessMock,
  mockPtySpawn,
  mockPtyInstance,
  mockReadinessProbe
} = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  runProcessMock: vi.fn(),
  mockPtySpawn: vi.fn(),
  mockReadinessProbe: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))

// The process-table snapshot (`ps -axo`) reads through execFile; the
// pgrep/ps probes go through the runProcess chokepoint.
vi.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock
}))

vi.mock('../../../src/shared/child-process/run-process', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runProcess: runProcessMock
}))

vi.mock('node-pty', () => ({
  spawn: mockPtySpawn
}))

vi.mock('../../../src/main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

vi.mock('../../../src/main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockReadinessProbe
}))

import { resetProcessTableSnapshotForTests } from '../../../src/shared/process-table-snapshot'
import type { PtyHandler } from '../../../src/relay/pty-handler'
import {
  beginPtyHandlerTest,
  createPtyRequestHelpers,
  endPtyHandlerTest,
  type MockDispatcher
} from '../../../src/relay/pty-handler-test-harness'
import {
  createAgentCompletionCoordinator,
  resetAgentCompletionCoordinatorIdentitiesForTest
} from '../../../src/renderer/src/components/terminal-pane/agent-completion-coordinator'
import { resetAgentProcessInspectionQueueForTests } from '../../../src/renderer/src/components/terminal-pane/agent-process-inspection-queue'
import type { RuntimeTerminalProcessInspection } from '../../../src/renderer/src/runtime/runtime-terminal-inspection'

/**
 * "Failure becomes fact" coercion, SSH relay completion site.
 *
 * The relay adapter (pty-shell-utils) swallows `pgrep`/`ps` failures and
 * resolves `{ foregroundProcess: <fallback>, hasChildProcesses: false }` — the
 * exact payload the agent-completion monitor reads as positive exit evidence.
 * On a distressed or minimal relay host (probe timeouts under load, procps
 * missing) the truth is "could not ask", which must stay `unverifiable` and
 * must never become a completion. Loss of contact is never evidence of death
 * (docs/reference/ssh-execution-boundary.md).
 */
describe('relay inspection under probe failure', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined

  const { spawnPty } = createPtyRequestHelpers(() => dispatcher)

  // Timeout-killed subprocess: what execFile yields when the host is too
  // loaded to answer the `ps -axo` table read inside the probe deadline.
  function timeoutKilledError(command: string): Error {
    const error = new Error(`spawn ${command} ETIMEDOUT`) as Error & {
      killed: boolean
      signal: string
      code: null
    }
    error.killed = true
    error.signal = 'SIGTERM'
    error.code = null
    return error
  }

  type ExecBehavior = 'healthy' | 'probe-failure'
  let execBehavior: ExecBehavior = 'healthy'

  function installExecFile(): void {
    execFileMock.mockImplementation(
      (command: string, args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (
          err: Error | null,
          result: { stdout: string; stderr: string }
        ) => void
        if (execBehavior === 'probe-failure') {
          callback(timeoutKilledError(command), { stdout: '', stderr: '' })
          return
        }
        if (command === 'ps' && args[0] === '-axo') {
          callback(null, {
            stdout: [
              `${process.pid} 1 Ss   bash -l`,
              `99999 ${process.pid} S+   node /home/dev/.local/bin/codex`
            ].join('\n'),
            stderr: ''
          })
          return
        }
        callback(new Error(`unexpected command ${command}`), { stdout: '', stderr: '' })
      }
    )
  }

  // The pgrep/ps probes reach the host through runProcess, which resolves
  // exit status as data and reports a probe deadline as `timedOut`.
  function installRunProcess(): void {
    runProcessMock.mockImplementation(async (spec: { program: string }) => {
      if (execBehavior === 'probe-failure') {
        return { code: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: true }
      }
      if (spec.program === 'pgrep') {
        return { code: 0, signal: null, stdout: '99999\n', stderr: '', timedOut: false }
      }
      throw new Error(`unexpected command ${spec.program}`)
    })
  }

  beforeEach(() => {
    execBehavior = 'healthy'
    execFileMock.mockReset()
    runProcessMock.mockReset()
    installExecFile()
    installRunProcess()
    resetProcessTableSnapshotForTests()
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe: mockReadinessProbe
    }))
    // The harness stubs processHasChildren for unrelated PTY tests; this suite
    // exercises the real relay adapter, including its failure handling.
    ;(ptyProcessProbes.processHasChildren as unknown as Mock).mockRestore()
    ;(ptyProcessProbes.probeProcessChildren as unknown as Mock).mockRestore()
    // node-pty reports the wrapper entrypoint as the foreground process for
    // node-launched agents; descendant scans resolve it to the real agent.
    mockPtySpawn.mockReturnValue({ ...mockPtyInstance, process: 'node' })
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
    resetAgentProcessInspectionQueueForTests()
    resetAgentCompletionCoordinatorIdentitiesForTest()
    resetProcessTableSnapshotForTests()
  })

  it('does not conclude an agent finished when the host process probes fail', async () => {
    const { id } = await spawnPty({})

    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => id,
      getSettings: () => null,
      // Real transport shape: the renderer awaits the relay RPC result and
      // treats whatever resolves as the inspection answer.
      inspectProcess: async (_settings, ptyId) =>
        (await dispatcher.callRequest('pty.inspectProcess', {
          id: ptyId
        })) as RuntimeTerminalProcessInspection,
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.startProcessTracking()
    coordinator.observeTitle('Codex working')

    // Healthy poll: the descendant scan proves codex is live in this pane.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    // Host distress: every process probe now times out. Codex is still
    // running; the host merely cannot answer.
    execBehavior = 'probe-failure'
    await vi.advanceTimersByTimeAsync(20_000)

    expect(dispatchCompletion).not.toHaveBeenCalled()

    coordinator.dispose()
  })

  // Old-client behavior proof (remote-wire-compatibility Rule 1/Rule 3): the
  // legacy fields keep the exact pre-evidence collapse, so a client that
  // predates `processEvidence` observes byte-identical host content.
  it('publishes unchanged legacy fields beside the evidence', async () => {
    const { id } = await spawnPty({})

    const healthy = await dispatcher.callRequest('pty.inspectProcess', { id })
    expect(healthy).toEqual({
      foregroundProcess: 'codex',
      hasChildProcesses: true,
      processEvidence: {
        foreground: { verdict: 'observed', processName: 'codex' },
        children: { verdict: 'live' }
      }
    })

    execBehavior = 'probe-failure'
    await vi.advanceTimersByTimeAsync(600)
    const failed = await dispatcher.callRequest('pty.inspectProcess', { id })
    expect(failed).toEqual({
      // node-pty's own record still answers the foreground question.
      foregroundProcess: 'node',
      // The pre-evidence collapse old clients have always received.
      hasChildProcesses: false,
      processEvidence: {
        foreground: { verdict: 'observed', processName: 'node' },
        children: { verdict: 'unverifiable', reason: expect.any(String) }
      }
    })
  })

  it('still confirms a real exit once the probes answer again', async () => {
    const { id } = await spawnPty({})

    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-2:leaf-1',
      getPtyId: () => id,
      getSettings: () => null,
      inspectProcess: async (_settings, ptyId) =>
        (await dispatcher.callRequest('pty.inspectProcess', {
          id: ptyId
        })) as RuntimeTerminalProcessInspection,
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.startProcessTracking()
    coordinator.observeTitle('Codex working')
    await vi.advanceTimersByTimeAsync(2_000)

    execBehavior = 'probe-failure'
    await vi.advanceTimersByTimeAsync(10_000)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    // Recovery, and the agent has genuinely exited: bash has the foreground
    // again and pgrep positively reports no children.
    execBehavior = 'healthy'
    execFileMock.mockImplementation(
      (command: string, args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (
          err: Error | null,
          result: { stdout: string; stderr: string }
        ) => void
        if (command === 'ps' && args[0] === '-axo') {
          callback(null, { stdout: `${process.pid} 1 Ss+  bash -l`, stderr: '' })
          return
        }
        callback(new Error(`unexpected command ${command}`), { stdout: '', stderr: '' })
      }
    )
    runProcessMock.mockImplementation(async (spec: { program: string }) => {
      if (spec.program === 'pgrep') {
        // pgrep ran and matched nothing: exits 1 with empty output.
        return { code: 1, signal: null, stdout: '', stderr: '', timedOut: false }
      }
      throw new Error(`unexpected command ${spec.program}`)
    })

    await vi.advanceTimersByTimeAsync(30_000)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('codex', {
      source: 'process-exit',
      quietedHookDone: false,
      terminalIdleConfirmed: true
    })

    coordinator.dispose()
  })
})
