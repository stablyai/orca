import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from './terminal-bracketed-paste'
import { iterateTerminalPastePlanChunks } from './terminal-paste-chunks'
import { createRedactedPasteExecutionDiagnostic } from './terminal-paste-diagnostics'
import {
  TERMINAL_PASTE_OPERATION_TIMEOUT_MS,
  TERMINAL_REMOTE_PASTE_OPERATION_TIMEOUT_MS
} from './terminal-paste-limits'
import { runTerminalPasteOperationWithTimeout } from './terminal-paste-operation-timeout'
import type {
  TerminalPasteExecutionReason,
  TerminalPasteExecutionResult,
  TerminalPastePlan,
  TerminalPasteTextOptions
} from './terminal-paste-model'

type ExecuteTerminalPastePlanArgs = {
  pasteText: (text: string, options?: TerminalPasteTextOptions) => void | Promise<void>
  writePty?: (data: string) => boolean | Promise<boolean>
  isTargetCurrent?: () => boolean
  canContinue?: () => boolean
  yieldToEventLoop?: () => Promise<void>
  operationTimeoutMs?: number
  now?: () => number
}

export async function executeTerminalPastePlan(
  plan: TerminalPastePlan,
  {
    pasteText,
    writePty,
    isTargetCurrent,
    canContinue,
    yieldToEventLoop = defaultYieldToEventLoop,
    operationTimeoutMs = getTerminalPasteOperationTimeoutMs(plan),
    now = defaultNow
  }: ExecuteTerminalPastePlanArgs
): Promise<TerminalPasteExecutionResult> {
  const startedAtMs = now()
  const finish = (
    status: TerminalPasteExecutionResult['status'],
    chunksWritten: number,
    reason?: TerminalPasteExecutionReason
  ): TerminalPasteExecutionResult =>
    result(status, plan, chunksWritten, Math.max(0, now() - startedAtMs), reason)

  if (plan.mode === 'reject') {
    return finish('rejected', 0, plan.rejectReason ?? 'paste-rejected')
  }
  if (isTargetCurrent && !isTargetCurrent()) {
    return finish('cancelled', 0, 'stale-target')
  }
  if (plan.mode !== 'chunked') {
    const pasteResult = await runTerminalPasteOperationWithTimeout(() => {
      return pasteText(plan.payload.plainText, {
        forceBracketedPaste: plan.mode === 'bracketed-terminal'
      })
    }, operationTimeoutMs)
    if (pasteResult.timedOut) {
      return finish('cancelled', 0, 'operation-timeout')
    }
    return finish('pasted', 1)
  }
  if (!writePty) {
    return finish('rejected', 0, 'pty-writer-unavailable')
  }

  let chunksWritten = 0
  let bracketedPasteOpen = false
  for (const chunk of iterateTerminalPastePlanChunks(plan)) {
    if (isTargetCurrent && !isTargetCurrent()) {
      if (bracketedPasteOpen && (!canContinue || canContinue())) {
        const closeResult = await runTerminalPasteOperationWithTimeout(
          () => writePty(BRACKETED_PASTE_END),
          operationTimeoutMs
        )
        if (closeResult.timedOut) {
          return finish('cancelled', chunksWritten, 'operation-timeout')
        }
        if (closeResult.value) {
          chunksWritten += 1
        }
      }
      return finish('cancelled', chunksWritten, 'stale-target')
    }
    if (canContinue && !canContinue()) {
      return finish('cancelled', chunksWritten, 'target-disconnected')
    }
    const writeResult = await runTerminalPasteOperationWithTimeout(
      () => writePty(chunk),
      operationTimeoutMs
    )
    if (writeResult.timedOut) {
      return finish('cancelled', chunksWritten, 'operation-timeout')
    }
    if (!writeResult.value) {
      return finish('cancelled', chunksWritten, 'target-disconnected')
    }
    chunksWritten += 1
    if (chunk === BRACKETED_PASTE_START) {
      bracketedPasteOpen = true
    } else if (chunk === BRACKETED_PASTE_END) {
      bracketedPasteOpen = false
    }
    await yieldToEventLoop()
  }
  return finish('pasted', chunksWritten)
}

export function getTerminalPasteOperationTimeoutMs(plan: TerminalPastePlan): number {
  // Why: SSH/remote-runtime acknowledged PTY writes can include network
  // backpressure; keep local paste hangs tight without aborting slow remotes.
  return plan.target.runtime.kind === 'ssh' || plan.target.runtime.kind === 'remote-runtime'
    ? TERMINAL_REMOTE_PASTE_OPERATION_TIMEOUT_MS
    : TERMINAL_PASTE_OPERATION_TIMEOUT_MS
}

function result(
  status: TerminalPasteExecutionResult['status'],
  plan: TerminalPastePlan,
  chunksWritten: number,
  durationMs: number,
  reason?: TerminalPasteExecutionReason
): TerminalPasteExecutionResult {
  const roundedDurationMs = Math.max(0, Math.round(durationMs))
  return {
    status,
    chunksWritten,
    durationMs: roundedDurationMs,
    diagnostic: createRedactedPasteExecutionDiagnostic({
      chunksWritten,
      durationMs: roundedDurationMs,
      plan,
      reason,
      status
    }),
    ...(reason ? { reason } : {})
  }
}

function defaultNow(): number {
  return globalThis.performance?.now?.() ?? Date.now()
}

function defaultYieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
