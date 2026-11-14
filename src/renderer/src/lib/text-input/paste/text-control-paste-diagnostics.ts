import type {
  TextControlPasteOptions,
  TextControlPastePayloadMeasurement,
  TextControlPasteResult,
  TextControlPasteSource
} from './text-control-paste-model'

type TextControlPasteDiagnosticMetadata = Pick<
  TextControlPastePayloadMeasurement,
  'byteLength' | 'hasControlSequences' | 'lineCount'
>

export function createRedactedTextControlPasteDiagnostic({
  byteLength,
  chunksWritten,
  durationMs,
  hasControlSequences,
  lineCount,
  mode,
  reason,
  source,
  status
}: {
  byteLength: number
  chunksWritten: number
  durationMs: number
  hasControlSequences?: boolean
  lineCount?: number
  mode?: 'direct' | 'chunked'
  reason?: 'empty' | 'target-unavailable' | 'too-large'
  source: TextControlPasteSource
  status: 'pasted' | 'rejected' | 'cancelled'
}): string {
  return [
    'text-control paste',
    `status=${status}`,
    mode ? `mode=${mode}` : null,
    'target=text-control',
    `source=${source}`,
    `bytes=${byteLength}`,
    `lines=${lineCount ?? 'unknown'}`,
    `chunks=${chunksWritten}`,
    `durationMs=${Math.max(0, Math.round(durationMs))}`,
    `controls=${hasControlSequences ?? 'unknown'}`,
    reason ? `reason=${reason}` : null,
    'content=redacted'
  ]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
}

export function getTextControlPasteSource(
  source: TextControlPasteOptions['source']
): TextControlPasteSource {
  return source ?? 'programmatic'
}

export function createTextControlPastedResult({
  byteLength,
  chunksWritten,
  durationMs,
  hasControlSequences,
  lineCount,
  mode,
  source
}: {
  byteLength: number
  chunksWritten: number
  durationMs: number
  hasControlSequences?: boolean
  lineCount?: number
  mode: 'direct' | 'chunked'
  source: TextControlPasteSource
}): TextControlPasteResult {
  return {
    status: 'pasted',
    mode,
    byteLength,
    chunksWritten,
    durationMs: Math.max(0, Math.round(durationMs)),
    redactedDiagnostic: createRedactedTextControlPasteDiagnostic({
      byteLength,
      chunksWritten,
      durationMs,
      hasControlSequences,
      lineCount,
      mode,
      source,
      status: 'pasted'
    })
  }
}

export function createTextControlRejectedResult(
  reason: 'empty' | 'target-unavailable' | 'too-large',
  metadata: number | TextControlPasteDiagnosticMetadata,
  source: TextControlPasteSource,
  durationMs: number
): TextControlPasteResult {
  const diagnosticMetadata = typeof metadata === 'number' ? { byteLength: metadata } : metadata
  return {
    status: 'rejected',
    reason,
    byteLength: diagnosticMetadata.byteLength,
    chunksWritten: 0,
    durationMs: Math.max(0, Math.round(durationMs)),
    redactedDiagnostic: createRedactedTextControlPasteDiagnostic({
      byteLength: diagnosticMetadata.byteLength,
      chunksWritten: 0,
      durationMs,
      hasControlSequences: diagnosticMetadata.hasControlSequences,
      lineCount: diagnosticMetadata.lineCount,
      reason,
      source,
      status: 'rejected'
    })
  }
}

export function createTextControlCancelledResult({
  byteLength,
  chunksWritten,
  durationMs,
  hasControlSequences,
  lineCount,
  source
}: {
  byteLength: number
  chunksWritten: number
  durationMs: number
  hasControlSequences?: boolean
  lineCount?: number
  source: TextControlPasteSource
}): TextControlPasteResult {
  return {
    status: 'cancelled',
    reason: 'target-unavailable',
    byteLength,
    chunksWritten,
    durationMs: Math.max(0, Math.round(durationMs)),
    redactedDiagnostic: createRedactedTextControlPasteDiagnostic({
      byteLength,
      chunksWritten,
      durationMs,
      hasControlSequences,
      lineCount,
      reason: 'target-unavailable',
      source,
      status: 'cancelled'
    })
  }
}
