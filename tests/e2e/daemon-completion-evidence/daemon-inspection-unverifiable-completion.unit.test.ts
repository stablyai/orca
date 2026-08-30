import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type * as pty from 'node-pty'

const { execFileMock, execFileSyncMock, killWithDescendantSweepMock, forceKillPosixMock } =
  vi.hoisted(() => ({
    execFileMock: vi.fn(),
    execFileSyncMock: vi.fn(),
    killWithDescendantSweepMock: vi.fn(),
    forceKillPosixMock: vi.fn()
  }))

// The process-table snapshot (`ps -axo`) reads through node:child_process
// execFile; the foreground resolver and tracker stay REAL so this suite
// exercises the production degraded-read handling, not a stub of it.
vi.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock
}))

vi.mock('../../../src/main/pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

// Teardown escalation must never signal a real process group from a test.
vi.mock('../../../src/main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: forceKillPosixMock
}))

import { TerminalHost } from '../../../src/main/daemon/terminal-host'
import { createDaemonPtySubprocessHandle } from '../../../src/main/daemon/pty-subprocess/subprocess-handle'
import { DaemonPtyAdapter } from '../../../src/main/daemon/daemon-pty-adapter'
import { inspectPtyProviderProcessForRenderer } from '../../../src/main/providers/pty-process-inspection'
import { resetProcessTableSnapshotForTests } from '../../../src/shared/process-table-snapshot'
import {
  createAgentCompletionCoordinator,
  resetAgentCompletionCoordinatorIdentitiesForTest
} from '../../../src/renderer/src/components/terminal-pane/agent-completion-coordinator'
import { resetAgentProcessInspectionQueueForTests } from '../../../src/renderer/src/components/terminal-pane/agent-process-inspection-queue'
import type { RuntimeTerminalProcessInspection } from '../../../src/renderer/src/runtime/runtime-terminal-inspection'

/**
 * "Failure becomes fact" coercion, DAEMON terminal-host inspection site — the
 * default macOS path: local panes are daemon-hosted, so the completion
 * monitor's inspectProcess lands in TerminalHost.inspectProcess via
 * DaemonPtyProcessInspection.
 *
 * The daemon's synchronous foreground read degrades in ways that used to be
 * indistinguishable from an observation: node-pty's POSIX title read silently
 * falls back to the spawned shell file when the native read fails, and the
 * async identity scan behind the 1s cache can be degraded (truncated table /
 * failed ps fork) so the cached agent identity goes stale without ever being
 * disproven. Both used to collapse into `{ foregroundProcess: <shell>,
 * hasChildProcesses: false }` — the exact payload the agent-completion monitor
 * reads as positive exit evidence. The truth is "could not ask", which must
 * stay `unverifiable` and never become a completion
 * (docs/reference/ssh-execution-boundary.md). Relay leg and local-provider leg
 * fixed by the two parent changes; this is the daemon leg.
 */
describe('daemon terminal-host inspection under degraded reads', () => {
  // Implausibly high so a leaked signal can never hit a real process.
  const SHELL_PID = 999_999_242
  // Minted worktree ids are `${repoId}::${path}`; the parser rejects anything else.
  const WORKTREE_ID = 'repo-daemon-evidence::/tmp/wt'
  const SESSION_ID = `${WORKTREE_ID}@@repro001`

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
                `999999555 ${SHELL_PID} S+   node /home/dev/.local/bin/codex`
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

  type MockNodePty = pty.IPty & {
    process: string
    _fireExit: (exitCode: number) => void
  }

  function createMockNodePtyProcess(): MockNodePty {
    const exitListeners: ((e: { exitCode: number; signal?: number }) => void)[] = []
    const proc = {
      pid: SHELL_PID,
      cols: 80,
      rows: 24,
      // node-pty reports the wrapper entrypoint for node-launched agents; the
      // daemon's descendant scan resolves it to the real agent.
      process: 'node',
      handleFlowControl: false,
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn((cb: (e: { exitCode: number; signal?: number }) => void) => {
        exitListeners.push(cb)
        return { dispose: vi.fn() }
      }),
      write: vi.fn(),
      resize: vi.fn(),
      clear: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      kill: vi.fn(() => {
        setTimeout(() => proc._fireExit(0), 5)
      }),
      _fireExit: (exitCode: number) => {
        exitListeners.forEach((cb) => cb({ exitCode, signal: 0 }))
      }
    }
    return proc as unknown as MockNodePty
  }

  let platformDescriptor: PropertyDescriptor | undefined
  let host: TerminalHost
  let adapter: DaemonPtyAdapter
  let mockProc: MockNodePty

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    // The default macOS topology: a daemon-hosted local pane.
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    psBehavior = 'healthy'
    execFileMock.mockReset()
    installExecFile()
    killWithDescendantSweepMock.mockReset()
    killWithDescendantSweepMock.mockResolvedValue(undefined)
    forceKillPosixMock.mockReset()
    resetProcessTableSnapshotForTests()

    mockProc = createMockNodePtyProcess()
    // Teardown escalation must still produce a physical exit for the session.
    forceKillPosixMock.mockImplementation(() => {
      setTimeout(() => mockProc._fireExit(137), 1)
    })
    host = new TerminalHost({
      // The REAL daemon subprocess handle (and with it the real foreground
      // tracker) over a scripted node-pty process.
      spawnSubprocess: (opts) =>
        createDaemonPtySubprocessHandle({
          process: mockProc,
          shellPath: '/bin/zsh',
          spawnCwd: '/tmp/wt',
          env: { PATH: '/usr/bin' },
          startupCommandDeliveredInShellArgs: false,
          reportsChildExitStatus: true,
          requestedCwd: '/tmp/wt',
          sessionId: opts.sessionId,
          startupAgentRecognition: null
        })
    })
    await host.createOrAttach({
      sessionId: SESSION_ID,
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })

    // The REAL app-side client leg: DaemonPtyAdapter.inspectProcess with its
    // socket call routed straight to the host. The daemon-request-router's
    // 'inspectProcess' / 'listSessions' cases are one-line delegations to
    // TerminalHost, so this preserves every production code path around the
    // wire itself (which the sibling wire test covers over a real socket).
    adapter = new DaemonPtyAdapter({
      socketPath: join(tmpdir(), 'daemon-evidence-unused.sock'),
      tokenPath: join(tmpdir(), 'daemon-evidence-unused.token')
    })
    type ClientInternals = {
      client: {
        request: (type: string, payload: unknown) => Promise<unknown>
        disconnect: () => void
        ensureConnected: () => Promise<void>
        ensureConnectedWithin: (ms: number) => Promise<void>
        getDaemonIdentity: () => null
        onEvent: (cb: (raw: unknown) => void) => () => void
      }
    }
    ;(adapter as unknown as ClientInternals).client = {
      request: async (type: string, payload: unknown) => {
        if (type === 'inspectProcess') {
          return host.inspectProcess((payload as { sessionId: string }).sessionId)
        }
        if (type === 'listSessions') {
          return { sessions: host.listSessions() }
        }
        throw new Error(`unexpected daemon request: ${type}`)
      },
      disconnect: () => {},
      ensureConnected: async () => {},
      ensureConnectedWithin: async () => {},
      getDaemonIdentity: () => null,
      onEvent: () => () => {}
    }
    // The production adoption flow that teaches the adapter about
    // daemon-surviving sessions (and makes hasPty answer for them).
    await adapter.reconcileOnStartup(new Set([WORKTREE_ID]))
  })

  afterEach(async () => {
    resetAgentProcessInspectionQueueForTests()
    resetAgentCompletionCoordinatorIdentitiesForTest()
    resetProcessTableSnapshotForTests()
    adapter?.dispose()
    vi.useRealTimers()
    await host?.dispose()
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
    vi.restoreAllMocks()
  })

  function createCoordinator(paneKey: string, dispatchCompletion: ReturnType<typeof vi.fn>) {
    return createAgentCompletionCoordinator({
      paneKey,
      getPtyId: () => SESSION_ID,
      getSettings: () => null,
      // Real production adapter chain for a daemon-hosted pane: the renderer's
      // window.api.pty.inspectProcess lands in the pty IPC handler, which
      // calls exactly this.
      inspectProcess: async (_settings, ptyId) =>
        (await inspectPtyProviderProcessForRenderer(
          adapter,
          ptyId
        )) as RuntimeTerminalProcessInspection,
      dispatchCompletion,
      isLive: () => true
    })
  }

  it('does not conclude an agent finished when the daemon reads degrade', async () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createCoordinator('tab-1:leaf-1', dispatchCompletion)

    coordinator.startProcessTracking()
    coordinator.observeTitle('Codex working')

    // Healthy polls: the first poll's identity scan proves codex is live in
    // this pane; the next poll surfaces it through the wrapper-hold.
    await vi.advanceTimersByTimeAsync(5_000)
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
    const dispatchCompletion = vi.fn()
    const coordinator = createCoordinator('tab-2:leaf-1', dispatchCompletion)

    coordinator.startProcessTracking()
    coordinator.observeTitle('Codex working')
    await vi.advanceTimersByTimeAsync(5_000)

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
    // Warm the identity: a healthy scan resolves the node wrapper to codex.
    await inspectPtyProviderProcessForRenderer(adapter, SESSION_ID)
    await vi.advanceTimersByTimeAsync(600)
    const healthy = await inspectPtyProviderProcessForRenderer(adapter, SESSION_ID)
    expect(healthy).toEqual({
      foregroundProcess: 'codex',
      hasChildProcesses: true,
      processEvidence: {
        foreground: { verdict: 'observed', processName: 'codex' },
        children: { verdict: 'live' }
      }
    })

    // Degraded scan with a shell-fallback title: the legacy fields keep the
    // exact pre-evidence collapse; the evidence says "could not ask".
    psBehavior = 'ps-failure'
    mockProc.process = 'zsh'
    await vi.advanceTimersByTimeAsync(2_000)
    const degraded = await inspectPtyProviderProcessForRenderer(adapter, SESSION_ID)
    expect(degraded).toEqual({
      foregroundProcess: 'zsh',
      hasChildProcesses: false,
      processEvidence: {
        foreground: { verdict: 'unverifiable', reason: expect.any(String) },
        children: { verdict: 'unverifiable', reason: expect.any(String) }
      }
    })

    // A real exit is a real observation: legacy and evidence agree. The first
    // read schedules the corroborating scan; the second observes its verdict.
    psBehavior = 'agent-exited'
    await vi.advanceTimersByTimeAsync(2_000)
    await inspectPtyProviderProcessForRenderer(adapter, SESSION_ID)
    await vi.advanceTimersByTimeAsync(1_500)
    const exited = await inspectPtyProviderProcessForRenderer(adapter, SESSION_ID)
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
