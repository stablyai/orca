import type { ChildProcess } from 'node:child_process'
import { createOutputSink } from './bounded-output-sink'
import {
  observeChildTermination,
  type ChildTerminationReporter
} from './child-termination-reporter'
import { forceTerminateProcessTree, signalProcessTree } from './process-tree-termination'
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_PROCESS_TIMEOUT_MS,
  type ProcessResult,
  type ProcessSpec
} from './process-spec'

export type ProcessCaptureOptions = Pick<
  ProcessSpec,
  'maxOutputBytes' | 'signal' | 'timeoutMs' | 'terminationBarrier'
>

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

export function captureRunProcess(
  child: ChildProcess,
  options: ProcessCaptureOptions,
  terminationReporter: ChildTerminationReporter,
  resolve: (result: ProcessResult) => void,
  reject: (error: unknown) => void
): void {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
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
    options.signal?.removeEventListener('abort', onAbort)
    child.stdout?.off('data', onStdoutData)
    child.stderr?.off('data', onStderrData)
    child.off('error', onError)
    child.off('exit', onExit)
    child.off('close', onClose)
    try {
      act()
    } finally {
      stdout.dispose()
      stderr.dispose()
      deferredError = null
    }
  }

  const onStdoutData = (chunk: Buffer | string): void => stdout.write(chunk)
  const onStderrData = (chunk: Buffer | string): void => stderr.write(chunk)
  child.stdout?.on('data', onStdoutData)
  child.stderr?.on('data', onStderrData)
  observeChildTermination(child, terminationReporter, options.terminationBarrier)
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let barrierDeadlineTimer: ReturnType<typeof setTimeout> | undefined
  const signalBarrierTree = (signal?: NodeJS.Signals): Promise<boolean> =>
    (typeof options.terminationBarrier === 'object'
      ? options.terminationBarrier.signal(child, signal)
      : signalProcessTree(child, signal)
    ).catch(() => false)
  const forceBarrierTree = (): Promise<boolean> =>
    (typeof options.terminationBarrier === 'object'
      ? options.terminationBarrier.force(child)
      : forceTerminateProcessTree(child)
    ).catch(() => false)

  const resolveFromClose = (code: number | null, signal: NodeJS.Signals | null): void =>
    settle(() =>
      resolve({
        code,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        outputTruncated: stdout.truncated() || stderr.truncated()
      })
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
    if (settled) {
      return
    }
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
    if (options.terminationBarrier) {
      barrierStopping = true
      initialBarrierTermination ??= signalBarrierTree()
      if (process.platform === 'win32') {
        void initialBarrierTermination.then((terminated) => {
          if (!terminated) {
            return
          }
          barrierAttemptComplete = true
          barrierTerminationVerified = true
          terminationReporter.report()
          resolveBarrierIfSafe()
        })
      }
    } else {
      terminate(child)
    }
    graceTimer ??= setTimeout(() => {
      if (options.terminationBarrier) {
        const initialTermination = initialBarrierTermination ?? Promise.resolve(false)
        if (process.platform === 'win32') {
          if (typeof options.terminationBarrier === 'object') {
            void Promise.all([initialTermination, forceBarrierTree()]).then(
              ([initialTerminated, forceTerminated]) => {
                barrierAttemptComplete = true
                barrierTerminationVerified = initialTerminated || forceTerminated
                terminationReporter.reportIf(barrierTerminationVerified)
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
            terminationReporter.reportIf(barrierTerminationVerified)
            resolveBarrierIfSafe()
          })
          return
        }
        void Promise.all([initialTermination, forceBarrierTree()]).then(
          ([_initialTerminated, forceTerminated]) => {
            barrierAttemptComplete = true
            barrierTerminationVerified = forceTerminated
            terminationReporter.reportIf(barrierTerminationVerified)
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
    options.timeoutMs === null
      ? undefined
      : setTimeout(() => {
          timedOut = true
          stopAndSettle()
        }, options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS)
  timer?.unref?.()

  // Why the same escalation: an aborted caller has stopped waiting, so an
  // unkillable child must not keep the promise alive on their behalf either.
  const onAbort = (): void => stopAndSettle()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  // Why check after subscribing: a signal that was already aborted never
  // fires the event, so the child would otherwise run to its full timeout on
  // behalf of a caller who had already given up.
  if (options.signal?.aborted) {
    onAbort()
  }

  const onError = (error: Error): void => {
    terminationReporter.reportIf(!child.pid)
    if (barrierStopping) {
      deferredError = error
      resolveBarrierIfSafe()
      return
    }
    settle(() => reject(error))
  }
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (!barrierStopping) {
      rootExitedBeforeBarrier = true
    }
    deferredExit = { code, signal }
    if (barrierStopping) {
      resolveBarrierIfSafe()
    }
  }
  const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (!barrierStopping) {
      rootExitedBeforeBarrier = true
    }
    if (barrierStopping) {
      deferredClose = { code, signal }
      resolveBarrierIfSafe()
      return
    }
    resolveFromClose(code, signal)
  }
  child.once('error', onError)
  child.once('exit', onExit)
  child.once('close', onClose)
}

/** Best-effort root termination, or whole-tree termination for barrier callers. */
function terminate(child: ChildProcess, signal?: NodeJS.Signals): void {
  try {
    child.kill(signal)
  } catch {
    /* already gone */
  }
}
