import { randomUUID } from 'node:crypto'
import { DaemonPtyAdapter } from '../../../src/main/daemon/daemon-pty-adapter'
import type { IPtyProvider } from '../../../src/main/providers/pty-provider-contract'
import { DAEMON_GENERATION_WORKTREE_ID } from '../fixtures/daemon-generation-fixture-contract'
import {
  recordProcessIdentity,
  recordProcessTree,
  terminateRecordedTree,
  waitForCondition,
  type RecordedProcessIdentity
} from './daemon-generation-processes'
import type { DaemonGeneration, DaemonGenerationRuntime } from './daemon-generation-safety-fixtures'

const MAX_CAPTURED_CHARS = 65_536
const PROBE_WIDTH_COLS = 200
const PROBE_HEIGHT_ROWS = 30

export type DaemonShellSession = {
  generation: DaemonGeneration
  sessionId: string
  adapter: DaemonPtyAdapter
  /** The PID the daemon reported for the PTY leader at spawn time. */
  spawnPid: number
  rootIdentity: RecordedProcessIdentity
  treeIdentities: RecordedProcessIdentity[]
  incarnationId: string | undefined
  output(): string
}

/** Buffers one session's stream off any provider that fans out `onData`. */
export function recordSessionOutput(
  provider: Pick<IPtyProvider, 'onData'>,
  sessionId: string
): { text(): string; stop(): void } {
  let text = ''
  const unsubscribe = provider.onData((event) => {
    if (event.id === sessionId) {
      text = `${text}${event.data}`.slice(-MAX_CAPTURED_CHARS)
    }
  })
  return { text: () => text, stop: unsubscribe }
}

/**
 * A real login shell under the daemon — not a fixture script. Journey 2 has to
 * compare the *shell* the user is typing into across the restart boundary, so
 * the PTY leader must be the shell itself.
 */
export async function spawnDaemonShellSession(options: {
  runtime: DaemonGenerationRuntime
  generation: DaemonGeneration
  role: string
  worktreeId?: string
}): Promise<DaemonShellSession> {
  const { runtime, generation, role, worktreeId = DAEMON_GENERATION_WORKTREE_ID } = options
  // Why the durable prefix: daemon inventory infers ownership from it, so a bare
  // id would resolve to unknown for reasons unrelated to what is under test.
  const sessionId = `${worktreeId}@@orca-j2-${generation.label}-${role}-${randomUUID().slice(0, 8)}`
  const adapter = new DaemonPtyAdapter({
    socketPath: generation.socketPath,
    tokenPath: generation.tokenPath,
    protocolVersion: generation.protocolVersion
  })
  const recorder = recordSessionOutput(adapter, sessionId)
  const result = await adapter.spawn({
    sessionId,
    isNewSession: true,
    cols: PROBE_WIDTH_COLS,
    rows: PROBE_HEIGHT_ROWS,
    cwd: runtime.rootDir,
    ...(process.platform === 'win32' ? { shellOverride: 'powershell.exe' } : {})
  })
  if (!result.pid) {
    throw new Error(`${generation.label}-${role} shell did not expose its PTY leader PID`)
  }
  const rootIdentity = await recordProcessIdentity(result.pid)
  return {
    generation,
    sessionId,
    adapter,
    spawnPid: result.pid,
    rootIdentity,
    treeIdentities: await recordProcessTree(rootIdentity),
    incarnationId: result.incarnationId,
    output: recorder.text
  }
}

/** Disposable fixture teardown: exact-identity kills only, never a bare PID. */
export async function disposeDaemonShellSessions(
  shells: readonly DaemonShellSession[]
): Promise<void> {
  for (const shell of shells) {
    shell.adapter.dispose()
  }
  if (shells.length > 0) {
    await terminateRecordedTree(shells.flatMap((shell) => shell.treeIdentities))
  }
}

/**
 * Ask the live shell for its own PID over the production write path, then read
 * the kernel's start time for that PID.
 *
 * Both halves are load-bearing. The write path proves *this* connection reaches
 * a shell that is still executing; the kernel start time proves the PID was not
 * recycled by a replacement shell. A same-id/new-process respawn passes every
 * weaker check and fails this one.
 */
export async function readShellProcessIdentity(options: {
  phase: string
  write: (data: string) => void
  readOutput: () => string
  timeoutMs?: number
}): Promise<RecordedProcessIdentity> {
  const { phase, write, readOutput, timeoutMs = 30_000 } = options
  // Why a per-phase nonce: reattach replays scrollback, so an earlier phase's
  // answer is sitting in the stream and would otherwise satisfy this probe.
  const marker = `ORCA_J2_SHELL_PID_${phase}_${randomUUID().replaceAll('-', '')}`
  // Why match the *expanded* value: the echoed command line carries the literal
  // `$$`/`$PID`, so only the shell's own reply contains digits.
  const reported = new RegExp(`${marker}=(\\d+)`)
  const command = process.platform === 'win32' ? `echo ${marker}=$PID\r` : `echo ${marker}=$$\r`

  let pid: number | null = null
  const deadline = Date.now() + timeoutMs
  // Why re-issue: a freshly spawned shell may still be sourcing its rc files and
  // will discard the first line. Repeats are idempotent for `echo`.
  while (Date.now() <= deadline && pid === null) {
    write(command)
    try {
      await waitForCondition(
        `${phase} shell PID reply`,
        () => {
          const match = reported.exec(readOutput())
          pid = match ? Number(match[1]) : null
          return pid !== null
        },
        3_000
      )
    } catch {
      // Fall through and re-issue until the outer deadline.
    }
  }
  if (pid === null) {
    throw new Error(
      `Shell never reported its PID for phase ${phase}. Tail: ${readOutput().slice(-500)}`
    )
  }
  return await recordProcessIdentity(pid)
}
