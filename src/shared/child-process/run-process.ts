import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type ChildProcess,
  type SpawnOptions as NodeSpawnOptions
} from 'node:child_process'
import { buildWindowsCmdShimCommandLine, isCmdInterpretedProgram } from './windows-command-line'

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
  timeoutMs?: number
  /** Written to stdin then closed. Omit to leave stdin empty and closed. */
  input?: string
  /** Cap on captured stdout/stderr; output past it is discarded. */
  maxOutputBytes?: number
  /** Kills the process when aborted; the result still reports the exit. */
  signal?: AbortSignal
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
    stdio: ['pipe', 'pipe', 'pipe'],
    // Why unconditional: Orca's main process is GUI-subsystem and owns no
    // console, so every console-subsystem child it starts gets a fresh visible
    // conhost that takes foreground — keystrokes typed into an Orca terminal at
    // that moment land in the black box instead.
    windowsHide: true,
    // Why never `shell: true`: it concatenates arguments without escaping (Node
    // itself warns DEP0190) and it silently makes windowsHide a no-op.
    shell: false
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
export function spawnProcess(spec: ProcessSpec): ChildProcess {
  const resolved = resolveSpawn(spec, process.platform)
  return nodeSpawn(resolved.file, [...resolved.args], resolved.options)
}

/**
 * Collects output up to a cap, so a chatty child cannot grow the heap.
 *
 * Accepts strings as well as buffers: a stream someone called `setEncoding` on
 * emits strings, and concatenating those as buffers throws inside a `data`
 * handler, where the rejection has nowhere to go and the caller just hangs.
 */
function createOutputSink(maxBytes: number): {
  write: (chunk: Buffer | string) => void
  text: () => string
} {
  const chunks: Buffer[] = []
  let bytes = 0
  return {
    write(raw) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      const remaining = maxBytes - bytes
      if (remaining <= 0) {
        return
      }
      chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk)
      bytes += chunk.length
    },
    text: () => Buffer.concat(chunks).toString('utf8')
  }
}

/**
 * Run a child process to completion and capture its output.
 *
 * Never rejects on a non-zero exit — the exit code is data. Rejects only when
 * the process could not be started at all.
 */
export function runProcess(spec: ProcessSpec): Promise<ProcessResult> {
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

    const settle = (act: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      clearTimeout(graceTimer)
      spec.signal?.removeEventListener('abort', onAbort)
      act()
    }

    child.stdout?.on('data', (chunk: Buffer | string) => stdout.write(chunk))
    child.stderr?.on('data', (chunk: Buffer | string) => stderr.write(chunk))
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

    /**
     * Stop the child, then settle whether or not it complies.
     *
     * Why settle regardless: `close` only fires once the child is really gone,
     * so one that traps the signal would hold the caller forever -- and both
     * the pwsh cache and the snapshot reader hand later callers their in-flight
     * promise, so a single unkillable child would wedge every one of them.
     */
    const stopAndSettle = (): void => {
      terminate(child)
      graceTimer ??= setTimeout(() => {
        terminate(child, 'SIGKILL')
        settle(() =>
          resolve({
            code: null,
            signal: null,
            stdout: stdout.text(),
            stderr: stderr.text(),
            timedOut
          })
        )
      }, PROCESS_EXIT_GRACE_MS)
      graceTimer.unref?.()
    }

    const timer = setTimeout(() => {
      timedOut = true
      stopAndSettle()
    }, spec.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS)
    timer.unref?.()

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

    child.once('error', (error) => settle(() => reject(error)))
    child.once('close', (code, signal) =>
      settle(() =>
        resolve({ code, signal, stdout: stdout.text(), stderr: stderr.text(), timedOut })
      )
    )

    // Why close rather than leave open: a child that reads stdin (a hook
    // draining its payload, a CLI probing for a TTY) otherwise blocks until the
    // timeout instead of seeing EOF immediately.
    child.stdin?.end(spec.input)
  })
}

/**
 * Best-effort termination of a captured child.
 *
 * Deliberately root-only: descendant reaping is the job-object owner's
 * responsibility, not every caller's.
 */
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
    timeout: spec.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS,
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
