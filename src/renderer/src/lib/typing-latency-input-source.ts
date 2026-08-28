/**
 * Splits typing-latency samples by how the character was entered.
 *
 * Why: a Hangul (or any CJK) commit and a plain keypress travel different
 * amounts of work — the commit hands the TUI a whole composed syllable while a
 * preedit jamo sends nothing at all — so pooling them into one percentile hides
 * which of the two is actually slow. Reporting them side by side is what
 * separates "IME input is slow" from "input is slow and the IME just makes each
 * character cost three keystrokes' worth of feedback".
 */
import {
  histogramLatencySamples,
  summarizeLatencySamples,
  type LatencyHistogram,
  type LatencyPercentiles
} from './typing-latency-diagnostic-summary'
import type { EchoSample, KeystrokeSource } from './typing-latency-echo-instrumentation'

/** Bounds memory during sustained typing; percentiles only need a rolling window. */
const MAX_SAMPLES = 2000

type SourceSamples = {
  parseMs: number[]
  paintMs: number[]
  bytes: number[]
  coalescing: number[]
  dispatchMs: number[]
}

export type InputSourceLatency = {
  echoParseMs: LatencyPercentiles
  echoPaintMs: LatencyPercentiles
  bytesPerKeystroke: LatencyPercentiles
  /** Keystrokes resolved by one echoing write; >1 means the TUI batched them. */
  echoCoalescing: LatencyPercentiles
  /** Commit to the moment xterm handed bytes to the pty; the rest is round trip. */
  dispatchMs: LatencyPercentiles
  /** Bucketed echoPaintMs; a second mode above 128ms means a slow scheduling path. */
  echoPaintHistogram: LatencyHistogram
}

export type InputSourceBreakdown = {
  ime: InputSourceLatency
  direct: InputSourceLatency
  /** Characters carried by each composition commit; 1 for a single Hangul syllable. */
  imeCommitChars: LatencyPercentiles
}

export type InputSourceTally = {
  add: (sample: EchoSample) => void
  addCommitChars: (count: number) => void
  breakdown: () => InputSourceBreakdown
}

function emptySamples(): SourceSamples {
  return { parseMs: [], paintMs: [], bytes: [], coalescing: [], dispatchMs: [] }
}

function push(values: number[], value: number): void {
  values.push(value)
  if (values.length > MAX_SAMPLES) {
    values.shift()
  }
}

function summarize(samples: SourceSamples): InputSourceLatency {
  return {
    echoParseMs: summarizeLatencySamples(samples.parseMs),
    echoPaintMs: summarizeLatencySamples(samples.paintMs),
    bytesPerKeystroke: summarizeLatencySamples(samples.bytes),
    echoCoalescing: summarizeLatencySamples(samples.coalescing),
    // Preedit jamo dispatch nothing and report -1; excluding them keeps the
    // percentile about real dispatches instead of averaging in a sentinel.
    dispatchMs: summarizeLatencySamples(samples.dispatchMs.filter((value) => value >= 0)),
    echoPaintHistogram: histogramLatencySamples(samples.paintMs)
  }
}

export function createInputSourceTally(): InputSourceTally {
  const bySource: Record<KeystrokeSource, SourceSamples> = {
    ime: emptySamples(),
    direct: emptySamples()
  }
  const commitChars: number[] = []
  return {
    add: (sample) => {
      const bucket = bySource[sample.source]
      push(bucket.parseMs, sample.parseMs)
      push(bucket.paintMs, sample.paintMs)
      push(bucket.bytes, sample.bytes)
      push(bucket.coalescing, sample.coalescing)
      push(bucket.dispatchMs, sample.dispatchMs)
    },
    addCommitChars: (count) => push(commitChars, count),
    breakdown: () => ({
      ime: summarize(bySource.ime),
      direct: summarize(bySource.direct),
      imeCommitChars: summarizeLatencySamples(commitChars)
    })
  }
}

export function emptyInputSourceBreakdown(): InputSourceBreakdown {
  return createInputSourceTally().breakdown()
}
