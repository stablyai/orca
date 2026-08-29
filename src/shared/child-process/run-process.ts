import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions as NodeSpawnOptions
} from 'node:child_process'
import { buildWindowsCmdShimCommandLine, isCmdInterpretedProgram } from './windows-command-line'
import { forceTerminateProcessTree, signalProcessTree } from './process-tree-termination'

import { createOutputSink } from './bounded-output-sink'

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
}

export const DEFAULT_PROCESS_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
/**
 * Grace between the timeout kill and giving up on the child's exit.
 *
 * Why give up at all: `close` only fires once the child is actually gone, and a
 * child that ignores the kill never emits it -- so the promise would outlive
 * its own deadline forever. Callers that cache an in-flight probe (the pwsh
 * availability cache, the process-table reader) would then hand every later
 * caller the same dead promise.
 */
const PROCESS_EXIT_GRACE_MS = 2_000
/**
 * Last resort for a barrier caller once tree termination could not be verified.
 *
 * Why bounded: waiting for the root's exit is what stops an unverified caller
 * mutating shared state under a live child, but a tree that neither dies nor
 * reports would otherwise leave the promise pending for the app's lifetime.
 */
const BARRIER_UNVERIFIED_EXIT_GRACE_MS = 10_000

export type ResolvedSpawn = {
  file: string
  args: readonly string[]
  options: NodeSpawnOptions
}

/**
 * Translate a spec into the exact `child_process.spawn` call to make.
 *
 * Kept pure and exported so the Windows branch is testable from macOS/Linux:
 * the decisions below are the whole point of this module, and they must not be
 * observable only on the platform that breaks.
 */
export function resolveSpawn(spec: ProcessSpec, platform: NodeJS.Platform): ResolvedSpawn {
  const args = spec.args ?? []
  const base: NodeSpawnOptions = {
    cwd: spec.cwd,
    env: spec.env,
    stdio: spec.stdio ?? ['pipe', 'pipe', 'pipe'],
    // Why unconditional: Orca's main process is GUI-subsystem and owns no
    // console, so every console-subsystem child it starts gets a fresh visible
    // conhost that takes foreground — keystrokes typed into an Orca terminal at
    // that moment land in the black box instead.
    windowsHide: true,
    detached: spec.detached,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
    // Why never `shell: true`: it concatenates arguments without escaping (Node
    // itself warns DEP0190) and it silently makes windowsHide a no-op.
    shell: false,
    ...(spec.terminationBarrier && platform !== 'win32' ? { detached: true } : {})
  }

  if (platform !== 'win32' || !isCmdInterpretedProgram(spec.program)) {
    return { file: spec.program, args, options: base }
  }

  // Node refuses to spawn `.cmd`/`.bat` without a shell (EINVAL, the
  // CVE-2024-27980 mitigation), so cmd.exe has to be the program. Building the
  // line ourselves — rather than handing Node `shell: true` — is what keeps the
  // arguments intact and the console hidden.
  const comSpec = spec.env?.ComSpec ?? process.env.ComSpec ?? 'cmd.exe'
  return {
    file: comSpec,
    args: [buildWindowsCmdShimCommandLine(spec.program, args)],
    options: { ...base, windowsVerbatimArguments: true }
  }
}

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
    return Promise.resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false })
  }
  const maxOutputBytes = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  return new Promise<ProcessResult>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawnProcess(spec)
    } catch (error) {
      reject(error)
      return
    }

    const stdout = createOutputSink(maxOutputBytes)
    const stderr = createOutputSink(maxOutputBytes)
    let timedOut = false
    let settled = false
    let barrierStopping = false
    let barrierAttemptComplete = false
    let barrierTerminationVerified = false
    let initialBarrierTermination: Promise<boolean> | undefined
    let deferredExit: { code: number | null; signal: NodeJS.Signals | null } | null = null
    let deferredClose: { code: number | null; signal: NodeJS.Signals | null } | null = null
    let deferredError: Error | null = null
    let rootExitedBeforeBarrier = false

    const settle = (act: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      clearTimeout(graceTimer)
      clearTimeout(barrierDeadlineTimer)
      spec.signal?.removeEventListener('abort', onAbort)
      act()
    }

    child.stdout?.on('data', (chunk: Buffer | string) => stdout.write(chunk))
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr.write(chunk)
      if (typeof spec.terminationBarrier === 'object') {
        spec.terminationBarrier.observeStderr?.(chunk)
      }
    })
    // Why listeners that do nothing: an unhandled `error` on a stream is an
    // uncaught exception, and that takes the whole main process down. A child
    // that exits without reading makes the queued stdin write fail with EPIPE,
    // and a broken pipe can surface on the read side too. The child's own
    // `error` listener does not cover its streams. Losing output is not worth a
    // crash, and the exit code still reaches the caller.
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream?.on('error', () => {})
    }

    let graceTimer: ReturnType<typeof setTimeout> | undefined
    let barrierDeadlineTimer: ReturnType<typeof setTimeout> | undefined
    const signalBarrierTree = (signal?: NodeJS.Signals): Promise<boolean> =>
      (typeof spec.terminationBarrier === 'object'
        ? spec.terminationBarrier.signal(child, signal)
        : signalProcessTree(child, signal)
      ).catch(() => false)
    const forceBarrierTree = (): Promise<boolean> =>
      (typeof spec.terminationBarrier === 'object'
        ? spec.terminationBarrier.force(child)
        : forceTerminateProcessTree(child)
      ).catch(() => false)

    const resolveFromClose = (code: number | null, signal: NodeJS.Signals | null): void =>
      settle(() =>
        resolve({ code, signal, stdout: stdout.text(), stderr: stderr.text(), timedOut })
      )

    const settleBarrierOutcome = (): void => {
      const rootExit = deferredClose ?? deferredExit
      if (deferredError) {
        settle(() => reject(deferredError))
        return
      }
      resolveFromClose(rootExit?.code ?? null, rootExit?.signal ?? null)
    }

    const resolveBarrierIfSafe = (): void => {
      const rootExit = deferredClose ?? deferredExit
      if (barrierTerminationVerified || (rootExitedBeforeBarrier && rootExit)) {
        settleBarrierOutcome()
        return
      }
      if (!barrierAttemptComplete) {
        return
      }
      // Why a second deadline: the tree survived every attempt and the root has
      // gone silent, so nothing else will ever settle this promise.
      barrierDeadlineTimer ??= setTimeout(settleBarrierOutcome, BARRIER_UNVERIFIED_EXIT_GRACE_MS)
      barrierDeadlineTimer.unref?.()
    }

    /**
     * Stop the child, then settle.
     *
     * Without a barrier, settle whether or not the child complies. With one, wait
     * for verified tree termination or a root exit first — a descendant can keep
     * `close` pending after the root exits, but failed verification must not let
     * callers mutate shared state — then settle on the deadline regardless.
     */
    const stopAndSettle = (): void => {
      if (spec.terminationBarrier) {
        barrierStopping = true
        initialBarrierTermination ??= signalBarrierTree()
        if (process.platform === 'win32') {
          void initialBarrierTermination.then((terminated) => {
            if (!terminated) {
              return
            }
            barrierAttemptComplete = true
            barrierTerminationVerified = true
            resolveBarrierIfSafe()
          })
        }
      } else {
        terminate(child)
      }
      graceTimer ??= setTimeout(() => {
        if (spec.terminationBarrier) {
          const initialTermination = initialBarrierTermination ?? Promise.resolve(false)
          if (process.platform === 'win32') {
            if (typeof spec.terminationBarrier === 'object') {
              void Promise.all([initialTermination, forceBarrierTree()]).then(
                ([initialTerminated, forceTerminated]) => {
                  barrierAttemptComplete = true
                  barrierTerminationVerified = initialTerminated || forceTerminated
                  if (!barrierTerminationVerified) {
                    // The barrier never confirmed the tree died, so the root
                    // would otherwise outlive the abort or timeout.
                    terminate(child, 'SIGKILL')
                  }
                  resolveBarrierIfSafe()
                }
              )
              return
            }
            void initialTermination.then((terminated) => {
              if (!terminated) {
                terminate(child, 'SIGKILL')
              }
              barrierAttemptComplete = true
              barrierTerminationVerified = terminated
              resolveBarrierIfSafe()
            })
            return
          }
          void Promise.all([initialTermination, forceBarrierTree()]).then(
            ([_initialTerminated, forceTerminated]) => {
              barrierAttemptComplete = true
              barrierTerminationVerified = forceTerminated
              if (!barrierTerminationVerified) {
                terminate(child, 'SIGKILL')
              }
              resolveBarrierIfSafe()
            }
          )
          return
        }
        terminate(child, 'SIGKILL')
        resolveFromClose(null, null)
      }, PROCESS_EXIT_GRACE_MS)
      graceTimer.unref?.()
    }

    const timer =
      spec.timeoutMs === null
        ? undefined
        : setTimeout(() => {
            timedOut = true
            stopAndSettle()
          }, spec.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS)
    timer?.unref?.()

    // Why the same escalation: an aborted caller has stopped waiting, so an
    // unkillable child must not keep the promise alive on their behalf either.
    const onAbort = (): void => stopAndSettle()
    spec.signal?.addEventListener('abort', onAbort, { once: true })
    // Why check after subscribing: a signal that was already aborted never
    // fires the event, so the child would otherwise run to its full timeout on
    // behalf of a caller who had already given up.
    if (spec.signal?.aborted) {
      onAbort()
    }

    child.once('error', (error) => {
      if (barrierStopping) {
        deferredError = error
        resolveBarrierIfSafe()
        return
      }
      settle(() => reject(error))
    })
    child.once('exit', (code, signal) => {
      if (!barrierStopping) {
        rootExitedBeforeBarrier = true
      }
      deferredExit = { code, signal }
      if (barrierStopping) {
        resolveBarrierIfSafe()
      }
    })
    child.once('close', (code, signal) => {
      if (!barrierStopping) {
        rootExitedBeforeBarrier = true
      }
      if (barrierStopping) {
        deferredClose = { code, signal }
        resolveBarrierIfSafe()
        return
      }
      resolveFromClose(code, signal)
    })

    // Why close rather than leave open: a child that reads stdin (a hook
    // draining its payload, a CLI probing for a TTY) otherwise blocks until the
    // timeout instead of seeing EOF immediately.
    child.stdin?.end(spec.input)
  })
}

/** Best-effort root termination, or whole-tree termination for barrier callers. */
function terminate(child: ChildProcess, signal?: NodeJS.Signals): void {
  try {
    child.kill(signal)
  } catch {
    /* already gone */
  }
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
    // Why ETIMEDOUT and not the signal: a timeout kills with SIGTERM, but so
    // does anything else that terminates the child, and only a timeout also
    // sets this error. Reading the signal alone reports a deliberately
    // stopped process as having timed out, which callers retry.
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
  }
}
