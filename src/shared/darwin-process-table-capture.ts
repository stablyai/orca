import { nameDarwinTerminals } from './darwin-terminal-names'
import { errorMessage } from './error-message'
import { ProcessTableCaptureError, PS_ARGS } from './process-table-snapshot'
import { withTimeout } from './promise-timeout-fallback'

let deviceColumnUnsupported = false
let terminalNamingInFlight: Promise<string> | null = null

export async function captureDarwinProcessTable(
  capture: (args: readonly string[], timeoutMs?: number) => Promise<string>,
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
  if (deviceColumnUnsupported || terminalNamingInFlight) {
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
  if (terminalNamingInFlight) {
    return canonicalCapture()
  }
  const controller = new AbortController()
  const pending = nameDarwinTerminals(captured, undefined, controller.signal)
  terminalNamingInFlight = pending
  // Uncancelable filesystem calls keep the slot until they drain.
  const clearNaming = (): void => {
    if (terminalNamingInFlight === pending) {
      terminalNamingInFlight = null
    }
  }
  void pending.then(clearNaming, clearNaming)
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
}
