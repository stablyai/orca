import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from './terminal-bracketed-paste'
import { iterateTerminalPastePlanChunks } from './terminal-paste-chunks'
import { createRedactedPasteExecutionDiagnostic } from './terminal-paste-diagnostics'
import {
  TERMINAL_PASTE_OPERATION_TIMEOUT_MS,
  TERMINAL_REMOTE_PASTE_OPERATION_TIMEOUT_MS
} from './terminal-paste-limits'
import { runTerminalPasteOperationWithTimeout } from './terminal-paste-operation-timeout'
import { runTerminalPtyInputTransaction } from './terminal-pty-input-transaction'
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
  args: ExecuteTerminalPastePlanArgs
): Promise<TerminalPasteExecutionResult> {
  return await runTerminalPtyInputTransaction(plan.target.ptyId, () =>
    executeTerminalPastePlanNow(plan, args)
  )
}

async function executeTerminalPastePlanNow(
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
        forceBracketedPaste: plan.mode === 'bracketed-terminal',
        ...(plan.windowsInputRecordNewline
          ? { windowsInputRecordNewline: plan.windowsInputRecordNewline }
          : {})
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
  // Why: best-effort — a close that hangs or throws must not mask the real exit reason.
  const closeBracketedPasteFrame = async (): Promise<{ timedOut: boolean }> => {
    if (!bracketedPasteOpen) {
      return { timedOut: false }
    }
    bracketedPasteOpen = false
    if (canContinue && !canContinue()) {
      return { timedOut: false }
    }
    try {
      const closeResult = await runTerminalPasteOperationWithTimeout(
        () => writePty(BRACKETED_PASTE_END),
        operationTimeoutMs
      )
      if (closeResult.timedOut) {
        return { timedOut: true }
      }
      if (closeResult.value) {
        chunksWritten += 1
      }
    } catch {
      // The frame stays open only because the writer itself is gone; nothing left to do.
    }
    return { timedOut: false }
  }

  const writeChunks = async (): Promise<ChunkedPasteOutcome> => {
    for (const chunk of iterateTerminalPastePlanChunks(plan)) {
      if (isTargetCurrent && !isTargetCurrent()) {
        return { status: 'cancelled', reason: 'stale-target' }
      }
      if (canContinue && !canContinue()) {
        return { status: 'cancelled', reason: 'target-disconnected' }
      }
      const writeResult = await runTerminalPasteOperationWithTimeout(
        () => writePty(chunk),
        operationTimeoutMs
      )
      // Why: a failed close chunk is already the close attempt; retrying would emit a stray end.
      if (writeResult.timedOut) {
        bracketedPasteOpen = bracketedPasteOpen && chunk !== BRACKETED_PASTE_END
        return { status: 'cancelled', reason: 'operation-timeout' }
      }
      if (!writeResult.value) {
        bracketedPasteOpen = bracketedPasteOpen && chunk !== BRACKETED_PASTE_END
        return { status: 'cancelled', reason: 'target-disconnected' }
      }
      chunksWritten += 1
      if (chunk === BRACKETED_PASTE_START) {
        bracketedPasteOpen = true
      } else if (chunk === BRACKETED_PASTE_END) {
        bracketedPasteOpen = false
      }
      await yieldToEventLoop()
    }
    return { status: 'pasted' }
  }

  let outcome!: ChunkedPasteOutcome
  let closeTimedOut = false
  try {
    outcome = await writeChunks()
  } finally {
    // Why: every exit, including an unexpected writer rejection, must leave the frame closed.
    closeTimedOut = (await closeBracketedPasteFrame()).timedOut
  }
  if (closeTimedOut && outcome.reason === 'stale-target') {
    return finish('cancelled', chunksWritten, 'operation-timeout')
  }
  return finish(outcome.status, chunksWritten, outcome.reason)
}

type ChunkedPasteOutcome = {
  status: TerminalPasteExecutionResult['status']
  reason?: TerminalPasteExecutionReason
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
