import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams
} from 'node:child_process'
import { resolveSpawn } from './spawn-resolution'
import { captureRunProcess } from './run-process-capture'
import { createChildTerminationReporter } from './child-termination-reporter'

export type {
  ChildProcessHandle,
  SpawnedProcess,
  ProcessSpec,
  ProcessTerminationBarrier,
  ProcessResult
} from './process-spec'
export { DEFAULT_PROCESS_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES } from './process-spec'
export { resolveSpawn, type ResolvedSpawn } from './spawn-resolution'
import type { ProcessSpec, ProcessResult } from './process-spec'
import { DEFAULT_PROCESS_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES } from './process-spec'
/**
 * Start a child process. Use for long-lived or streaming children.
 *
 * The caller owns the returned streams, including their `error` events — an
 * unhandled one is an uncaught exception that takes the main process down.
 * `runProcess` handles that for you; here it cannot, because a blanket handler
 * would also defeat callers that track and remove their own listeners.
 */
export function spawnProcess(spec: ProcessSpec): ChildProcessWithoutNullStreams {
  const resolved = resolveSpawn(spec, process.platform)
  return nodeSpawn(
    resolved.file,
    [...resolved.args],
    resolved.options
  ) as ChildProcessWithoutNullStreams
}

/**
 * Run a child process to completion and capture its output.
 *
 * Never rejects on a non-zero exit — the exit code is data. Rejects only when
 * the process could not be started at all.
 */
export function runProcess(spec: ProcessSpec): Promise<ProcessResult> {
  if (spec.signal?.aborted) {
    spec.onChildTerminated?.()
    return Promise.resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false })
  }

  return new Promise<ProcessResult>((resolve, reject) => {
    const terminationReporter = createChildTerminationReporter(spec.onChildTerminated)
    let child: ChildProcess
    try {
      child = spawnProcess(spec)
    } catch (error) {
      terminationReporter.report()
      reject(error)
      return
    }

    // Lifecycle callbacks must not capture input, argv or the caller's environment.
    captureRunProcess(
      child,
      {
        maxOutputBytes: spec.maxOutputBytes,
        timeoutMs: spec.timeoutMs,
        signal: spec.signal,
        terminationBarrier: spec.terminationBarrier
      },
      terminationReporter,
      resolve,
      reject
    )

    // Why close rather than leave open: a child that reads stdin (a hook
    // draining its payload, a CLI probing for a TTY) otherwise blocks until the
    // timeout instead of seeing EOF immediately.
    child.stdin?.end(spec.input)
  })
}

/**
 * Synchronous variant, for the call sites that genuinely cannot await — CLI
 * entry points and teardown paths that run while the event loop is stopping.
 *
 * Prefer `runProcess`. This exists so those callers still get the Windows
 * invariants (hidden console, correct `.cmd` argv) instead of reaching for
 * `execFileSync` and re-deciding them.
 */
export function runProcessSync(spec: ProcessSpec): ProcessResult {
  const resolved = resolveSpawn(spec, process.platform)
  const result = nodeSpawnSync(resolved.file, [...resolved.args], {
    ...resolved.options,
    input: spec.input,
    timeout: spec.timeoutMs === null ? undefined : (spec.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS),
    maxBuffer: spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    encoding: 'buffer'
  })
  if (result.error && (result.error as NodeJS.ErrnoException).code !== 'ETIMEDOUT') {
    throw result.error
  }
  return {
    code: result.status,
    signal: result.signal,
    stdout: result.stdout?.toString('utf8') ?? '',
    stderr: result.stderr?.toString('utf8') ?? '',
    // Why always false: spawnSync reports an overrun as an ENOBUFS error, and
    // the guard above rethrows it, so no truncated result reaches this point.
    outputTruncated: false,
    // Why ETIMEDOUT and not the signal: a timeout kills with SIGTERM, but so
    // does anything else that terminates the child, and only a timeout also
    // sets this error. Reading the signal alone reports a deliberately
    // stopped process as having timed out, which callers retry.
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
  }
}
