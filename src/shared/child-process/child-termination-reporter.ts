import type { ChildProcess } from 'node:child_process'
import type { ProcessTerminationBarrier } from './process-spec'

export type ChildTerminationReporter = {
  report: () => void
  reportIf: (confirmed: boolean) => void
}

export function createChildTerminationReporter(callback?: () => void): ChildTerminationReporter {
  let reported = false
  const report = (): void => {
    if (reported) {
      return
    }
    reported = true
    callback?.()
  }
  return { report, reportIf: (confirmed) => (confirmed ? report() : undefined) }
}

export function observeChildTermination(
  child: ChildProcess,
  reporter: ChildTerminationReporter,
  barrier?: boolean | ProcessTerminationBarrier
): void {
  const observeStderr =
    typeof barrier === 'object'
      ? (chunk: Buffer | string): void => barrier.observeStderr?.(chunk)
      : undefined
  if (observeStderr) {
    child.stderr?.on('data', observeStderr)
  }
  // A settled capture still needs late pipe errors and actual termination proof.
  child.on('error', ignoreLateProcessError)
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream?.on('error', ignoreLateProcessError)
  }
  child.once('close', () => {
    if (observeStderr) {
      child.stderr?.off('data', observeStderr)
    }
    reporter.report()
  })
}

function ignoreLateProcessError(): void {}
