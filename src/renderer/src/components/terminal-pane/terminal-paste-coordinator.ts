import { createRedactedPasteDiagnostic } from './terminal-paste-diagnostics'
import {
  TERMINAL_PASTE_CHUNK_MAX_BYTES,
  TERMINAL_PASTE_DIRECT_MAX_BYTES,
  TERMINAL_PASTE_MAX_BYTES
} from './terminal-paste-limits'
import {
  measureTerminalPastePayloadMetadata,
  measureTerminalPastePayloadMetadataWithYield
} from './terminal-paste-payload-metadata'
import type {
  TerminalPastePayload,
  TerminalPastePlan,
  TerminalPasteSource,
  TerminalPasteTarget
} from './terminal-paste-model'

export {
  TERMINAL_PASTE_CHUNK_MAX_BYTES,
  TERMINAL_PASTE_DIRECT_MAX_BYTES,
  TERMINAL_PASTE_MAX_BYTES,
  TERMINAL_PASTE_OPERATION_TIMEOUT_MS,
  TERMINAL_REMOTE_PASTE_OPERATION_TIMEOUT_MS
} from './terminal-paste-limits'
export { executeTerminalPastePlan } from './terminal-paste-executor'
export { getTerminalPasteOperationTimeoutMs } from './terminal-paste-executor'
export { chunkTerminalPastePlan, iterateTerminalPastePlanChunks } from './terminal-paste-chunks'
export { createRedactedPasteDiagnostic } from './terminal-paste-diagnostics'
export type {
  TerminalPasteExecutionResult,
  TerminalPastePayload,
  TerminalPastePlan,
  TerminalPasteRuntime,
  TerminalPasteSource,
  TerminalPasteTarget,
  TerminalPasteTextOptions
} from './terminal-paste-model'

type PlanTerminalPasteArgs = {
  text: string
  source: TerminalPasteSource
  target: TerminalPasteTarget
  forceBracketedPaste?: boolean
  forceBracketedPasteForMultiline?: boolean
  terminalBracketedPasteMode?: boolean
  hasRichText?: boolean
  maxDirectBytes?: number
  maxChunkBytes?: number
  maxBytes?: number
}

type PlanTerminalPasteWithYieldArgs = PlanTerminalPasteArgs & {
  measureYieldAfterCodeUnits?: number
  yieldToEventLoop?: () => Promise<void>
}

export function createTerminalPastePayload({
  text,
  source,
  hasRichText = false,
  maxBytes
}: {
  text: string
  source: TerminalPasteSource
  hasRichText?: boolean
  maxBytes?: number
}): TerminalPastePayload {
  const metadata = measureTerminalPastePayloadMetadata(text, { stopAfterBytes: maxBytes })
  return {
    plainText: text,
    source,
    byteLength: metadata.byteLength,
    lineCount: metadata.lineCount,
    hasRichText,
    hasControlSequences: metadata.hasControlSequences
  }
}

export function planTerminalPaste({
  text,
  source,
  target,
  forceBracketedPaste = false,
  forceBracketedPasteForMultiline = false,
  terminalBracketedPasteMode = false,
  hasRichText = false,
  maxDirectBytes = TERMINAL_PASTE_DIRECT_MAX_BYTES,
  maxChunkBytes = TERMINAL_PASTE_CHUNK_MAX_BYTES,
  maxBytes = TERMINAL_PASTE_MAX_BYTES
}: PlanTerminalPasteArgs): TerminalPastePlan {
  const payload = createTerminalPastePayload({ text, source, hasRichText, maxBytes })
  return buildTerminalPastePlan({
    forceBracketedPaste,
    forceBracketedPasteForMultiline,
    maxBytes,
    maxChunkBytes,
    maxDirectBytes,
    payload,
    target,
    terminalBracketedPasteMode
  })
}

export async function planTerminalPasteWithYield({
  text,
  source,
  target,
  forceBracketedPaste = false,
  forceBracketedPasteForMultiline = false,
  terminalBracketedPasteMode = false,
  hasRichText = false,
  maxDirectBytes = TERMINAL_PASTE_DIRECT_MAX_BYTES,
  maxChunkBytes = TERMINAL_PASTE_CHUNK_MAX_BYTES,
  maxBytes = TERMINAL_PASTE_MAX_BYTES,
  measureYieldAfterCodeUnits,
  yieldToEventLoop
}: PlanTerminalPasteWithYieldArgs): Promise<TerminalPastePlan> {
  const metadata = await measureTerminalPastePayloadMetadataWithYield(text, {
    stopAfterBytes: maxBytes,
    yieldAfterCodeUnits: measureYieldAfterCodeUnits,
    yieldToEventLoop
  })
  const payload: TerminalPastePayload = {
    plainText: text,
    source,
    byteLength: metadata.byteLength,
    lineCount: metadata.lineCount,
    hasRichText,
    hasControlSequences: metadata.hasControlSequences
  }
  return buildTerminalPastePlan({
    forceBracketedPaste,
    forceBracketedPasteForMultiline,
    maxBytes,
    maxChunkBytes,
    maxDirectBytes,
    payload,
    target,
    terminalBracketedPasteMode
  })
}

function buildTerminalPastePlan({
  payload,
  target,
  forceBracketedPaste,
  forceBracketedPasteForMultiline,
  terminalBracketedPasteMode,
  maxDirectBytes,
  maxChunkBytes,
  maxBytes
}: {
  payload: TerminalPastePayload
  target: TerminalPasteTarget
  forceBracketedPaste: boolean
  forceBracketedPasteForMultiline: boolean
  terminalBracketedPasteMode: boolean
  maxDirectBytes: number
  maxChunkBytes: number
  maxBytes: number
}): TerminalPastePlan {
  const shouldChunk = payload.byteLength > maxDirectBytes
  const effectiveForceBracketedPaste =
    forceBracketedPaste || (forceBracketedPasteForMultiline && payload.lineCount > 1)
  const shouldBracketChunk = effectiveForceBracketedPaste || terminalBracketedPasteMode
  const mode = choosePasteMode({
    byteLength: payload.byteLength,
    forceBracketedPaste: effectiveForceBracketedPaste,
    shouldChunk,
    maxBytes
  })
  const plan: TerminalPastePlan = {
    target,
    payload,
    mode,
    newlinePolicy: mode === 'chunked' || mode === 'bracketed-terminal' ? 'terminal-cr' : 'preserve',
    runtimeKey: target.runtime.runtimeKey,
    ...(shouldChunk ? { maxChunkBytes } : {}),
    bracketed: mode === 'bracketed-terminal' || (mode === 'chunked' && shouldBracketChunk),
    redactedDiagnostic: '',
    ...(mode === 'reject' ? { rejectReason: 'payload-too-large' } : {})
  }
  return {
    ...plan,
    redactedDiagnostic: createRedactedPasteDiagnostic(plan)
  }
}

function choosePasteMode({
  byteLength,
  forceBracketedPaste,
  shouldChunk,
  maxBytes
}: {
  byteLength: number
  forceBracketedPaste: boolean
  shouldChunk: boolean
  maxBytes: number
}): TerminalPastePlan['mode'] {
  if (byteLength > maxBytes) {
    return 'reject'
  }
  if (shouldChunk) {
    return 'chunked'
  }
  return forceBracketedPaste ? 'bracketed-terminal' : 'direct'
}
