import { nameDarwinTerminals } from './darwin-terminal-names'
import {
  claimDarwinTerminalNaming,
  isDarwinTerminalNamingInFlight,
  resetDarwinTerminalNamingForTests
} from './darwin-terminal-naming-single-flight'
import { errorMessage } from './error-message'
import { ProcessTableCaptureError, PS_ARGS } from './process-table-snapshot'
import { withTimeout } from './promise-timeout-fallback'

let deviceColumnUnsupported = false

export async function captureDarwinProcessTable(
  capture: (
    args: readonly string[],
    timeoutMs?: number,
    /** Skip the in-process reader. */ subprocess?: boolean
  ) => Promise<string>,
  validate: (stdout: string) => string,
  budgetMs: number
): Promise<string> {
  const startedAt = performance.now()
  const remainingBudget = (): number => {
    const remaining = Math.floor(budgetMs - (performance.now() - startedAt))
    if (remaining <= 0) {
      throw new ProcessTableCaptureError('capture_over_budget')
    }
    return remaining
  }
  const canonicalCapture = (): Promise<string> => capture(PS_ARGS, remainingBudget())
  // ps names terminals out of process, so a busy naming slot (perhaps a stalled lstat) never blocks it.
  const subprocessCapture = (): Promise<string> => capture(PS_ARGS, remainingBudget(), true)
  if (isDarwinTerminalNamingInFlight()) {
    return subprocessCapture()
  }
  if (deviceColumnUnsupported) {
    return canonicalCapture()
  }
  let captured: string
  try {
    captured = await capture(['-axo', PS_ARGS[1].replace('tty=', 'tdev=')], remainingBudget())
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      (error.code !== 1 && error.code !== 2) ||
      ('killed' in error && error.killed === true) ||
      !/^(?:ps: tdev: keyword not found|error: unknown user-defined format specifier "tdev")$/m.test(
        errorMessage(error)
      )
    ) {
      throw error
    }
    deviceColumnUnsupported = true
    return canonicalCapture()
  }
  remainingBudget()
  const controller = new AbortController()
  // In-process `tty=` captures share this slot, so the canonical fallback never names concurrently either.
  const pending = claimDarwinTerminalNaming(() =>
    nameDarwinTerminals(captured, undefined, controller.signal)
  )
  if (!pending) {
    return subprocessCapture()
  }
  let remainingMs: number
  try {
    remainingMs = remainingBudget()
  } catch (error) {
    controller.abort()
    throw error
  }
  const named = await withTimeout<{ value: string } | { error: unknown } | null>(
    pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    ),
    remainingMs,
    null
  )
  if (named === null) {
    controller.abort()
    throw new ProcessTableCaptureError('capture_over_budget')
  }
  remainingBudget()
  if ('error' in named) {
    return canonicalCapture()
  }
  let validated: string
  try {
    validated = validate(named.value)
  } catch {
    return canonicalCapture()
  }
  remainingBudget()
  return validated
}

export function resetDarwinProcessTableCaptureForTests(): void {
  deviceColumnUnsupported = false
  resetDarwinTerminalNamingForTests()
}
