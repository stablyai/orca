import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import type * as pty from 'node-pty'

const { execFileMock, execFileSyncMock, killWithDescendantSweepMock, forceKillPosixMock } =
  vi.hoisted(() => ({
    execFileMock: vi.fn(),
    execFileSyncMock: vi.fn(),
    killWithDescendantSweepMock: vi.fn(),
    forceKillPosixMock: vi.fn()
  }))

// The identity scan's `ps -axo` fork; scripted to fail so no scan can settle.
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

import { createDaemonPtySubprocessHandle } from '../../../src/main/daemon/pty-subprocess/subprocess-handle'
import {
  startDaemonAdapterHarness,
  type DaemonAdapterHarness
} from '../../../src/main/daemon/daemon-pty-adapter-test-harness'
import { inspectPtyProviderProcessForRenderer } from '../../../src/main/providers/pty-process-inspection'

/**
 * The daemon inspection evidence must survive the REAL wire: DaemonServer →
 * request router → JSON socket → DaemonPtyAdapter. The sibling suite proves
 * the monitor consequences in-process; this one proves the `processEvidence`
 * field actually crosses the daemon protocol, beside byte-identical legacy
 * fields, on the exact socket a macOS daemon pane uses.
 */
describe('daemon inspection evidence over the daemon socket', () => {
  const SHELL_PID = 999_999_311
  const AGENT_SESSION_ID = 'repo-daemon-wire::/tmp/wt@@wire0001'
  const SHELL_SESSION_ID = 'repo-daemon-wire::/tmp/wt@@wire0002'

  type MockNodePty = pty.IPty & { process: string; _fireExit: (exitCode: number) => void }

  function createMockNodePtyProcess(): MockNodePty {
    const exitListeners: ((e: { exitCode: number; signal?: number }) => void)[] = []
    const proc = {
      pid: SHELL_PID,
      cols: 80,
      rows: 24,
      process: 'codex',
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

  let harness: DaemonAdapterHarness
  let procsBySession: Map<string, MockNodePty>

  beforeEach(async () => {
    execFileMock.mockReset()
    execFileMock.mockImplementation(
      (_command: string, _args: string[], _opts: unknown, cb: unknown) => {
        ;(cb as (err: Error | null, result: { stdout: string; stderr: string }) => void)(
          new Error('ps unavailable in wire test'),
          { stdout: '', stderr: '' }
        )
      }
    )
    killWithDescendantSweepMock.mockReset()
    killWithDescendantSweepMock.mockResolvedValue(undefined)
    forceKillPosixMock.mockReset()
    procsBySession = new Map()
    forceKillPosixMock.mockImplementation(() => {
      setTimeout(() => procsBySession.forEach((proc) => proc._fireExit(137)), 1)
    })
    harness = await startDaemonAdapterHarness((opts) => {
      const proc = createMockNodePtyProcess()
      proc.process = opts.sessionId === AGENT_SESSION_ID ? 'codex' : 'zsh'
      procsBySession.set(opts.sessionId, proc)
      return createDaemonPtySubprocessHandle({
        process: proc,
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
  })

  afterEach(async () => {
    harness.adapter?.dispose()
    await harness.server?.shutdown()
    rmSync(harness.dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('carries observed and unverifiable evidence across the socket, legacy fields intact', async () => {
    const agentPane = await harness.adapter.spawn({
      sessionId: AGENT_SESSION_ID,
      cols: 80,
      rows: 24
    })
    const shellPane = await harness.adapter.spawn({
      sessionId: SHELL_SESSION_ID,
      cols: 80,
      rows: 24
    })

    // A recognized agent title is a direct observation — no scan involved.
    expect(await inspectPtyProviderProcessForRenderer(harness.adapter, agentPane.id)).toEqual({
      foregroundProcess: 'codex',
      hasChildProcesses: true,
      processEvidence: {
        foreground: { verdict: 'observed', processName: 'codex' },
        children: { verdict: 'live' }
      }
    })

    // A shell-shaped title with no settled scan: node-pty's silent shell
    // fallback makes it indistinguishable from a degraded read. The legacy
    // fields keep the exact pre-evidence collapse the monitor used to read as
    // exit proof; the evidence now says "could not ask".
    expect(await inspectPtyProviderProcessForRenderer(harness.adapter, shellPane.id)).toEqual({
      foregroundProcess: 'zsh',
      hasChildProcesses: false,
      processEvidence: {
        foreground: { verdict: 'unverifiable', reason: expect.any(String) },
        children: { verdict: 'unverifiable', reason: expect.any(String) }
      }
    })
  })
})
