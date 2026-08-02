import type {
  TerminalPasteExecutionReason,
  TerminalPasteExecutionResult,
  TerminalPastePlan
} from './terminal-paste-model'

export function createRedactedPasteDiagnostic(plan: TerminalPastePlan): string {
  return [
    'terminal paste',
    `mode=${plan.mode}`,
    'target=terminal',
    `runtime=${plan.runtimeKey}`,
    `bytes=${plan.payload.byteLength}`,
    `lines=${plan.payload.lineCount}`,
    `source=${plan.payload.source}`,
    `rich=${plan.payload.hasRichText}`,
    `controls=${plan.payload.hasControlSequences}`,
    'content=redacted'
  ].join(' ')
}

export function createRedactedPasteExecutionDiagnostic({
  chunksWritten,
  durationMs,
  plan,
  reason,
  status
}: {
  chunksWritten: number
  durationMs: number
  plan: TerminalPastePlan
  reason?: TerminalPasteExecutionReason | string
  status: TerminalPasteExecutionResult['status']
}): string {
  return [
    plan.redactedDiagnostic,
    `status=${status}`,
    `chunks=${chunksWritten}`,
    `durationMs=${Math.max(0, Math.round(durationMs))}`,
    reason ? `reason=${formatDiagnosticReason(reason)}` : null
  ]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
}

function formatDiagnosticReason(reason: string): string {
  return /^[a-z0-9-]{1,64}$/i.test(reason) ? reason : 'untrusted'
}
