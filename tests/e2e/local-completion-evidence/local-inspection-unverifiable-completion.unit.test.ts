import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MacosTccLoginShell from '../../../src/main/providers/macos-tcc-login-shell'

const {
  execFileMock,
  execFileSyncMock,
  spawnMock,
  existsSyncMock,
  statSyncMock,
  accessSyncMock,
  mkdirSyncMock,
  writeFileSyncMock,
  prepareMacosTccLoginShellMock,
  resolveAgentForegroundProcessMock,
  readWindowsPtyJobProcessIdsMock,
  killWithDescendantSweepMock,
  isWslAvailableAsyncMock,
  wslUncDirectoryExistsMock,
  createShellPromptReadinessProbeMock
} = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  existsSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  accessSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  prepareMacosTccLoginShellMock: vi.fn(),
  resolveAgentForegroundProcessMock: vi.fn(),
  readWindowsPtyJobProcessIdsMock: vi.fn(),
  killWithDescendantSweepMock: vi.fn(),
  isWslAvailableAsyncMock: vi.fn(),
  wslUncDirectoryExistsMock: vi.fn(),
  createShellPromptReadinessProbeMock: vi.fn()
}))

// The process-table snapshot (`ps -axo`) reads through node:child_process
// execFile; the foreground resolver stays REAL so this suite exercises the
// production degraded-read handling, not a stub of it.
vi.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock
}))

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  statSync: statSyncMock,
  accessSync: accessSyncMock,
  mkdirSync: mkdirSyncMock,
  writeFileSync: writeFileSyncMock,
  chmodSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  constants: { X_OK: 1 }
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/orca-user-data')
  }
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock
}))

vi.mock('../../../src/main/providers/macos-tcc-login-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof MacosTccLoginShell>()),
  prepareMacosTccLoginShell: prepareMacosTccLoginShellMock
}))

vi.mock('../../../src/main/pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

vi.mock('../../../src/main/providers/windows-powershell-executable', () => ({
  resolveWindowsPowerShellExecutablePath: () => 'C:\\pwsh.exe',
  resolveWindowsPowerShellSpawnChain: () => ['C:\\pwsh.exe'],
  getWindowsCmdPath: () => 'C:\\Windows\\System32\\cmd.exe'
}))

vi.mock('../../../src/main/wsl', () => ({
  parseWslPath: () => null,
  toLinuxPath: (path: string) => path,
  toWindowsWslPath: (path: string) => path,
  getDefaultWslDistro: () => 'Ubuntu',
  isWslAvailableAsync: () => isWslAvailableAsyncMock(),
  wslUncDirectoryExists: (...args: unknown[]) => wslUncDirectoryExistsMock(...args)
}))

vi.mock('../../../src/main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: createShellPromptReadinessProbeMock
}))

import { LocalPtyProvider } from '../../../src/main/providers/local-pty-provider'
import {
  applyLocalPtyProviderMockDefaults,
  createLocalPtyMockProcess,
  installLocalPtyProviderEnvSandbox,
  type LocalPtyExitCallback,
  type LocalPtyMockProcess
} from '../../../src/main/providers/local-pty-provider-test-harness'
import { inspectPtyProviderProcessForRenderer } from '../../../src/main/providers/pty-process-inspection'
import { resetProcessTableSnapshotForTests } from '../../../src/shared/process-table-snapshot'
import {
  createAgentCompletionCoordinator,
  resetAgentCompletionCoordinatorIdentitiesForTest
} from '../../../src/renderer/src/components/terminal-pane/agent-completion-coordinator'
import { resetAgentProcessInspectionQueueForTests } from '../../../src/renderer/src/components/terminal-pane/agent-process-inspection-queue'
import type { RuntimeTerminalProcessInspection } from '../../../src/renderer/src/runtime/runtime-terminal-inspection'

/**
 * "Failure becomes fact" coercion, LOCAL child-inspection site.
 *
 * The local provider's foreground read degrades in two ways that used to be
 * indistinguishable from an observation: the cached process-table snapshot can
 * miss the pane's whole subtree (truncation / distress), and the `ps` fork can
 * fail outright. Both used to collapse into `{ foregroundProcess: <shell>,
 * hasChildProcesses: false }` — the exact payload the agent-completion monitor
 * reads as positive exit evidence. The truth is "could not ask", which must
 * stay `unverifiable` and must never become a completion
 * (docs/reference/ssh-execution-boundary.md). This is the local leg of the
 * monitor whose relay leg was fixed by the relay-completion-evidence change.
 */
describe('local inspection under process-table failure', () => {
  installLocalPtyProviderEnvSandbox()

  let provider: LocalPtyProvider
  let mockProc: LocalPtyMockProcess
  let exitCb: LocalPtyExitCallback | undefined

  const SHELL_PID = 4242

  // What the pane's process table looks like in each phase. `healthy` and
  // `agent-exited` are real observations; `table-missing-pane` is a scan that
  // completed but never contained the pane's subtree; `ps-failure` is the
  // fork failing under load.
  type PsBehavior = 'healthy' | 'table-missing-pane' | 'ps-failure' | 'agent-exited'
  let psBehavior: PsBehavior = 'healthy'

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

  function installExecFile(): void {
    execFileMock.mockImplementation(
      (command: string, args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (
          err: Error | null,
          result: { stdout: string; stderr: string }
        ) => void
        if (command !== 'ps' || args[0] !== '-axo') {
          callback(new Error(`unexpected command ${command}`), { stdout: '', stderr: '' })
          return
        }
        switch (psBehavior) {
          case 'healthy':
            callback(null, {
              stdout: [
                `${SHELL_PID} 1 Ss   -zsh`,
                `5555 ${SHELL_PID} S+   node /home/dev/.local/bin/codex`
              ].join('\n'),
              stderr: ''
            })
            return
          case 'table-missing-pane':
            // The scan "succeeded" but the table never contained the pane's
            // shell or its descendants.
            callback(null, { stdout: '1 0 Ss   /sbin/launchd', stderr: '' })
            return
          case 'ps-failure':
            callback(timeoutKilledError(command), { stdout: '', stderr: '' })
            return
          case 'agent-exited':
            callback(null, { stdout: `${SHELL_PID} 1 Ss+  -zsh`, stderr: '' })
        }
      }
    )
  }

  beforeEach(() => {
    vi.useFakeTimers()
    psBehavior = 'healthy'
    execFileMock.mockReset()
    installExecFile()
    resetProcessTableSnapshotForTests()
    applyLocalPtyProviderMockDefaults({
      existsSyncMock,
      statSyncMock,
      accessSyncMock,
      mkdirSyncMock,
      writeFileSyncMock,
      prepareMacosTccLoginShellMock,
      resolveAgentForegroundProcessMock,
      readWindowsPtyJobProcessIdsMock,
      killWithDescendantSweepMock,
      isWslAvailableAsyncMock,
      wslUncDirectoryExistsMock,
      createShellPromptReadinessProbeMock
    })
    exitCb = undefined
    mockProc = createLocalPtyMockProcess({
      get: () => exitCb,
      set: (cb) => {
        exitCb = cb
      }
    })
    mockProc.pid = SHELL_PID
    // node-pty reports the wrapper entrypoint for node-launched agents; the
    // descendant scan resolves it to the real agent.
    mockProc.process = 'node'
    spawnMock.mockReturnValue(mockProc)
    provider = new LocalPtyProvider()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })

  afterEach(() => {
    resetAgentProcessInspectionQueueForTests()
    resetAgentCompletionCoordinatorIdentitiesForTest()
    resetProcessTableSnapshotForTests()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function createCoordinator(
    paneKey: string,
    id: string,
    dispatchCompletion: ReturnType<typeof vi.fn>
  ) {
    return createAgentCompletionCoordinator({
      paneKey,
      getPtyId: () => id,
      getSettings: () => null,
      // Real production adapter chain for a local pane: the renderer's
      // window.api.pty.inspectProcess lands in the pty IPC handler, which
      // calls exactly this.
      inspectProcess: async (_settings, ptyId) =>
        (await inspectPtyProviderProcessForRenderer(
          provider,
          ptyId
        )) as RuntimeTerminalProcessInspection,
      dispatchCompletion,
      isLive: () => true
    })
  }

  it('does not conclude an agent finished when the local process reads degrade', async () => {
    const { id } = await provider.spawn({ cols: 80, rows: 24 })

    const dispatchCompletion = vi.fn()
    const coordinator = createCoordinator('tab-1:leaf-1', id, dispatchCompletion)

    coordinator.startProcessTracking()
    coordinator.observeTitle('Codex working')

    // Healthy poll: the descendant scan proves codex is live in this pane.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    // Distress: the cached table stops containing the pane's subtree, and
    // node-pty's native title read degrades to the spawn file (the shell) —
    // its documented fallback. Codex is still running; nothing observed it.
    psBehavior = 'table-missing-pane'
    mockProc.process = 'zsh'
    await vi.advanceTimersByTimeAsync(4_000)

    // Full distress: the ps fork now fails outright.
    psBehavior = 'ps-failure'
    await vi.advanceTimersByTimeAsync(20_000)

    expect(dispatchCompletion).not.toHaveBeenCalled()

    coordinator.dispose()
  })

  it('still confirms a real exit once the table answers again', async () => {
    const { id } = await provider.spawn({ cols: 80, rows: 24 })

    const dispatchCompletion = vi.fn()
    const coordinator = createCoordinator('tab-2:leaf-1', id, dispatchCompletion)

    coordinator.startProcessTracking()
    coordinator.observeTitle('Codex working')
    await vi.advanceTimersByTimeAsync(2_000)

    psBehavior = 'ps-failure'
    mockProc.process = 'zsh'
    await vi.advanceTimersByTimeAsync(10_000)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    // Recovery, and the agent has genuinely exited: the shell holds the
    // foreground again and the table positively shows no descendants.
    psBehavior = 'agent-exited'
    await vi.advanceTimersByTimeAsync(30_000)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('codex', {
      source: 'process-exit',
      quietedHookDone: false,
      terminalIdleConfirmed: true
    })

    coordinator.dispose()
  })

  it('publishes unchanged legacy fields beside the evidence', async () => {
    const { id } = await provider.spawn({ cols: 80, rows: 24 })

    const healthy = await inspectPtyProviderProcessForRenderer(provider, id)
    expect(healthy).toEqual({
      foregroundProcess: 'codex',
      hasChildProcesses: true,
      processEvidence: {
        foreground: { verdict: 'observed', processName: 'codex' },
        children: { verdict: 'live' }
      }
    })

    // Degraded scan with a remembered agent: the legacy field keeps the
    // stable-cache collapse; the evidence says "could not ask".
    psBehavior = 'ps-failure'
    mockProc.process = 'zsh'
    await vi.advanceTimersByTimeAsync(600)
    const degraded = await inspectPtyProviderProcessForRenderer(provider, id)
    expect(degraded).toEqual({
      foregroundProcess: 'codex',
      hasChildProcesses: false,
      processEvidence: {
        foreground: { verdict: 'unverifiable', reason: expect.any(String) },
        children: { verdict: 'unverifiable', reason: expect.any(String) }
      }
    })

    // A real exit is a real observation: legacy and evidence agree.
    psBehavior = 'agent-exited'
    await vi.advanceTimersByTimeAsync(600)
    const exited = await inspectPtyProviderProcessForRenderer(provider, id)
    expect(exited).toEqual({
      foregroundProcess: 'zsh',
      hasChildProcesses: false,
      processEvidence: {
        foreground: { verdict: 'observed', processName: 'zsh' },
        children: { verdict: 'exited' }
      }
    })
  })
})
