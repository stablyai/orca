import type { TypingInputSource } from './input-events'

export type EchoCandidate = {
  t0: number
  /** Trusted DOM event timestamp; the gap to t0 is time the input waited behind other renderer work. */
  eventAt: number | null
  source: TypingInputSource
  text: string
  dispatchedAt: number | null
  /** First PTY output handed to the renderer's output scheduler after dispatch. */
  arrivedAt: number | null
  status:
    | 'undispatched'
    | 'dispatched'
    | 'unmatched-undispatched'
    | 'unmatched-dispatched'
    | 'prevented'
}

export type RecordedKeystroke = {
  candidate: EchoCandidate
  unmatched: number
}

export function createEchoCandidate(
  t0: number,
  source: TypingInputSource,
  text: string,
  eventAt: number | null = null
): EchoCandidate {
  return {
    t0,
    eventAt,
    source,
    text,
    dispatchedAt: null,
    arrivedAt: null,
    status: 'undispatched'
  }
}

export type EchoBatch = {
  candidates: EchoCandidate[]
  hasAttributionGap: boolean
  outputBytes: number
  outputWrites: number
  firstWriteAt: number | null
  parsedAt: number | null
}

export type EchoSourceCounts = Record<TypingInputSource, number>

export type ExactEchoSample = {
  attribution: 'single-input'
  source: TypingInputSource
  text: string
  inputToDispatchMs: number
  dispatchToParseMs: number
  parseToPaintMs: number
  inputToPaintMs: number
  /** Null when the event was untrusted or had no usable timestamp. */
  eventToHandlerMs: number | null
  eventToPaintMs: number | null
  /** Null when no output reached the renderer scheduler before the first xterm write was observed. */
  dispatchToArrivalMs: number | null
  arrivalToWriteMs: number | null
  writeToParseMs: number | null
  /** Interval bounds on performance.now(), for overlap with renderer long tasks. */
  startedAt: number
  paintedAt: number
  outputBytes: number
  outputWrites: number
}

export type AmbiguousEchoBurst = {
  attribution: 'ambiguous-burst'
  reason: 'overlapping-inputs' | 'attribution-gap'
  inputCount: number
  sourceCounts: EchoSourceCounts
  /** Bounds from the earliest and latest candidate dispatch to the first parsed output batch. */
  firstOutputParseFromFirstDispatchMs: number
  firstOutputParseFromLastDispatchMs: number
  parseToPaintMs: number
  outputBatchBytes: number
  outputBatchWrites: number
}

export type EchoObservation = ExactEchoSample | AmbiguousEchoBurst

function countSources(candidates: readonly EchoCandidate[]): EchoSourceCounts {
  const counts: EchoSourceCounts = { direct: 0, ime: 0 }
  for (const candidate of candidates) {
    counts[candidate.source] += 1
  }
  return counts
}

export function createEchoObservation(batch: EchoBatch, paintedAt: number): EchoObservation | null {
  const parsedAt = batch.parsedAt
  if (parsedAt === null || batch.candidates.length === 0) {
    return null
  }
  if (batch.candidates.length === 1 && !batch.hasAttributionGap) {
    const candidate = batch.candidates[0]
    if (!candidate) {
      return null
    }
    const dispatchedAt = candidate.dispatchedAt ?? candidate.t0
    const { eventAt, arrivedAt } = candidate
    const firstWriteAt = batch.firstWriteAt
    return {
      attribution: 'single-input',
      source: candidate.source,
      text: candidate.text,
      inputToDispatchMs: Math.max(0, dispatchedAt - candidate.t0),
      dispatchToParseMs: Math.max(0, parsedAt - dispatchedAt),
      parseToPaintMs: Math.max(0, paintedAt - parsedAt),
      inputToPaintMs: Math.max(0, paintedAt - candidate.t0),
      eventToHandlerMs: eventAt === null ? null : Math.max(0, candidate.t0 - eventAt),
      eventToPaintMs: eventAt === null ? null : Math.max(0, paintedAt - eventAt),
      dispatchToArrivalMs: arrivedAt === null ? null : Math.max(0, arrivedAt - dispatchedAt),
      arrivalToWriteMs:
        arrivedAt === null || firstWriteAt === null ? null : Math.max(0, firstWriteAt - arrivedAt),
      writeToParseMs: firstWriteAt === null ? null : Math.max(0, parsedAt - firstWriteAt),
      startedAt: eventAt ?? candidate.t0,
      paintedAt,
      outputBytes: batch.outputBytes,
      outputWrites: batch.outputWrites
    }
  }
  const dispatchTimes = batch.candidates.map((candidate) => candidate.dispatchedAt ?? candidate.t0)
  const firstDispatch = Math.min(...dispatchTimes)
  const lastDispatch = Math.max(...dispatchTimes)
  return {
    attribution: 'ambiguous-burst',
    reason: batch.hasAttributionGap ? 'attribution-gap' : 'overlapping-inputs',
    inputCount: batch.candidates.length,
    sourceCounts: countSources(batch.candidates),
    firstOutputParseFromFirstDispatchMs: Math.max(0, parsedAt - firstDispatch),
    firstOutputParseFromLastDispatchMs: Math.max(0, parsedAt - lastDispatch),
    parseToPaintMs: Math.max(0, paintedAt - parsedAt),
    outputBatchBytes: batch.outputBytes,
    outputBatchWrites: batch.outputWrites
  }
}
