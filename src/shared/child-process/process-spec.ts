// The public contract for Orca's single child-process entry point. Split from
// run-process.ts so the runner stays under its line cap; import the runtime
// functions from run-process, which re-exports everything here.
import type { ChildProcess, SpawnOptions as NodeSpawnOptions } from 'node:child_process'

export type ChildProcessHandle = ChildProcess

export type SpawnedProcess = ChildProcess

/**
 * The single place Orca starts a child process.
 *
 * Why one place: six decisions have to be made every time a child is spawned,
 * POSIX forgives all six, and Windows punishes each of them differently —
 * console visibility, argument quoting, `.cmd` interpretation, binary
 * resolution, timeout policy, and how the tree is later terminated. Made
 * per-call-site, they were right in some files and wrong in others, and the
 * wrong ones reached users as stolen keyboard focus, mangled agent prompts and
 * orphaned process trees.
 *
 * Callers outside this directory must not import `node:child_process`; a guard
 * test enforces that against a shrinking allowlist.
 */

export type ProcessSpec = {
  /**
   * Program to run. On Windows this should already be an absolute path —
   * spawning by bare name depends on the child's PATH, which under Group Policy
   * or a stripped Electron environment can resolve to nothing.
   */
  program: string
  args?: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Kill the process (and, on Windows, its console) after this long. */
  timeoutMs?: number | null
  /** Written to stdin then closed. Omit to leave stdin empty and closed. */
  input?: string
  /** Cap on captured stdout/stderr; output past it is discarded. */
  maxOutputBytes?: number
  /** Kills the process when aborted; the result still reports the exit. */
  signal?: AbortSignal
  /** Keep the child in its own POSIX process group for tree termination. */
  detached?: boolean
  /** Preserve a caller-owned Windows command line such as a cmd.exe invocation. */
  windowsVerbatimArguments?: boolean
  /** Streaming callers may suppress child output for auxiliary processes. */
  stdio?: NodeSpawnOptions['stdio']
  /** Kill the whole process tree and do not settle until termination is verified. */
  terminationBarrier?: boolean | ProcessTerminationBarrier
  /** Called once when the child exits or tree termination is verified. */
  onChildTerminated?: () => void
}

export type ProcessTerminationBarrier = {
  observeStderr?: (chunk: Buffer | string) => void
  signal: (child: ChildProcess, signal?: NodeJS.Signals) => Promise<boolean>
  force: (child: ChildProcess) => Promise<boolean>
}

export type ProcessResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** True when the process was killed by `timeoutMs` rather than exiting. */
  timedOut: boolean
  /** True when stdout or stderr exceeded `maxOutputBytes` and was clipped. */
  outputTruncated?: boolean
}

export const DEFAULT_PROCESS_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
