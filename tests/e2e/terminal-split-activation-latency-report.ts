import { summarizeLatencies, type LatencyDistribution } from './codex-composer-echo-latency-probe'
import type { SplitLatencySample } from './terminal-split-activation-latency-phases'

export type BenchmarkRevisionIdentity = {
  headSha: string
  dirty: boolean
}

export type SampleSummary = {
  counts: {
    requested: number
    attempted: number
    success: number
    missing: number
    unattempted: number
    missingEvents: {
      keydown: number
      focus: number
      cwdRequest: number
      cwdSettled: number
      ptySpawnRequest: number
      ptySpawnResult: number
      ptyBind: number
      fixtureUnlockRequest: number
      fixtureUnlockIpcWrite: number
      fixtureReadyParse: number
      input: number
      firstEcho: number
      paneCount: number
      ptyIdentity: number
      ptyExit: number
      cleanup: number
    }
  }
  distributions: {
    shortcutToFocusMs: LatencyDistribution
    shortcutToCwdRequestMs: LatencyDistribution
    cwdLookupMs: LatencyDistribution
    cwdSettleToPtySpawnRequestMs: LatencyDistribution
    ptySpawnRequestToResultMs: LatencyDistribution
    ptySpawnResultToBindMs: LatencyDistribution
    shortcutToPtyBindMs: LatencyDistribution
    ptyBindToFixtureUnlockRequestMs: LatencyDistribution
    fixtureUnlockRequestToIpcWriteMs: LatencyDistribution
    fixtureUnlockIpcWriteToReadyParseMs: LatencyDistribution
    fixtureReadyParseToInputMs: LatencyDistribution
    shortcutToFirstEchoMs: LatencyDistribution
    ptyBindToFirstEchoMs: LatencyDistribution
    inputToFirstEchoMs: LatencyDistribution
  }
}

export type BrowserWindowState = {
  browserWindowVisible: boolean
  windowCount: number
}

export type TerminalSplitLatencyReportConfig = {
  warmupCycles: number
  measuredCycles: number
  maxMeasuredCycles: number
  testTimeoutMs: number
  splitChord: string
  closeChord: string
  sampleTimeoutMs: number
  cleanupTimeoutMs: number
  processCwdCacheExpiryWaitMs: number
}

export type BenchmarkReportResult = {
  report: Record<string, unknown>
  warmupSummary: SampleSummary
  measuredSummary: SampleSummary
}

function valuesFor(
  samples: SplitLatencySample[],
  key: keyof SampleSummary['distributions']
): number[] {
  return samples.flatMap((sample) => {
    const value = sample[key]
    return value === null ? [] : [value]
  })
}

export function summarizeSamples(samples: SplitLatencySample[], requested: number): SampleSummary {
  const missingEvents = {
    keydown: samples.filter((sample) => sample.keydownAtMs === null).length,
    focus: samples.filter((sample) => sample.focusAtMs === null).length,
    cwdRequest: samples.filter((sample) => sample.cwdRequestAtMs === null).length,
    cwdSettled: samples.filter((sample) => sample.cwdSettledAtMs === null).length,
    ptySpawnRequest: samples.filter((sample) => sample.ptySpawnRequestAtMs === null).length,
    ptySpawnResult: samples.filter((sample) => sample.ptySpawnResultAtMs === null).length,
    ptyBind: samples.filter((sample) => sample.ptyBoundAtMs === null).length,
    fixtureUnlockRequest: samples.filter((sample) => sample.fixtureUnlockRequestedAtMs === null)
      .length,
    fixtureUnlockIpcWrite: samples.filter((sample) => sample.fixtureUnlockIpcWriteAtMs === null)
      .length,
    fixtureReadyParse: samples.filter((sample) => sample.fixtureReadyParsedAtMs === null).length,
    input: samples.filter((sample) => sample.inputAtMs === null).length,
    firstEcho: samples.filter((sample) => sample.firstEchoAtMs === null).length,
    paneCount: samples.filter((sample) => sample.paneCountAfterProbe !== 2).length,
    ptyIdentity: samples.filter((sample) => sample.newPtyId === sample.sourcePtyId).length,
    ptyExit: samples.filter((sample) => !sample.ptyExitObserved).length,
    cleanup: samples.filter((sample) => sample.cleanupError !== null).length
  }
  const success = samples.filter((sample) => sample.success).length
  return {
    counts: {
      requested,
      attempted: samples.length,
      success,
      missing: samples.length - success,
      unattempted: Math.max(0, requested - samples.length),
      missingEvents
    },
    distributions: {
      shortcutToFocusMs: summarizeLatencies(valuesFor(samples, 'shortcutToFocusMs')),
      shortcutToCwdRequestMs: summarizeLatencies(valuesFor(samples, 'shortcutToCwdRequestMs')),
      cwdLookupMs: summarizeLatencies(valuesFor(samples, 'cwdLookupMs')),
      cwdSettleToPtySpawnRequestMs: summarizeLatencies(
        valuesFor(samples, 'cwdSettleToPtySpawnRequestMs')
      ),
      ptySpawnRequestToResultMs: summarizeLatencies(
        valuesFor(samples, 'ptySpawnRequestToResultMs')
      ),
      ptySpawnResultToBindMs: summarizeLatencies(valuesFor(samples, 'ptySpawnResultToBindMs')),
      shortcutToPtyBindMs: summarizeLatencies(valuesFor(samples, 'shortcutToPtyBindMs')),
      ptyBindToFixtureUnlockRequestMs: summarizeLatencies(
        valuesFor(samples, 'ptyBindToFixtureUnlockRequestMs')
      ),
      fixtureUnlockRequestToIpcWriteMs: summarizeLatencies(
        valuesFor(samples, 'fixtureUnlockRequestToIpcWriteMs')
      ),
      fixtureUnlockIpcWriteToReadyParseMs: summarizeLatencies(
        valuesFor(samples, 'fixtureUnlockIpcWriteToReadyParseMs')
      ),
      fixtureReadyParseToInputMs: summarizeLatencies(
        valuesFor(samples, 'fixtureReadyParseToInputMs')
      ),
      shortcutToFirstEchoMs: summarizeLatencies(valuesFor(samples, 'shortcutToFirstEchoMs')),
      ptyBindToFirstEchoMs: summarizeLatencies(valuesFor(samples, 'ptyBindToFirstEchoMs')),
      inputToFirstEchoMs: summarizeLatencies(valuesFor(samples, 'inputToFirstEchoMs'))
    }
  }
}

export function buildBenchmarkReport(args: {
  label: string
  revision: BenchmarkRevisionIdentity
  headfulRun: boolean
  windowState: BrowserWindowState
  documentVisibility: string
  testRepoPath: string
  warmupSamples: SplitLatencySample[]
  measuredSamples: SplitLatencySample[]
  abortError: Error | null
  config: TerminalSplitLatencyReportConfig
}): BenchmarkReportResult {
  const warmupSummary = summarizeSamples(args.warmupSamples, args.config.warmupCycles)
  const measuredSummary = summarizeSamples(args.measuredSamples, args.config.measuredCycles)
  const runComplete =
    warmupSummary.counts.success === args.config.warmupCycles &&
    measuredSummary.counts.success === args.config.measuredCycles &&
    args.abortError === null
  const headlineMs = runComplete
    ? {
        shortcutToFocusP50: measuredSummary.distributions.shortcutToFocusMs.p50,
        shortcutToFocusP95: measuredSummary.distributions.shortcutToFocusMs.p95,
        shortcutToFocusMax: measuredSummary.distributions.shortcutToFocusMs.max,
        shortcutToPtyBindP50: measuredSummary.distributions.shortcutToPtyBindMs.p50,
        shortcutToPtyBindP95: measuredSummary.distributions.shortcutToPtyBindMs.p95,
        shortcutToPtyBindMax: measuredSummary.distributions.shortcutToPtyBindMs.max,
        shortcutToFirstEchoP50: measuredSummary.distributions.shortcutToFirstEchoMs.p50,
        shortcutToFirstEchoP95: measuredSummary.distributions.shortcutToFirstEchoMs.p95,
        shortcutToFirstEchoMax: measuredSummary.distributions.shortcutToFirstEchoMs.max
      }
    : null
  return {
    report: {
      schemaVersion: 2,
      benchmark: 'terminal-split-activation-latency',
      label: args.label,
      revision: args.revision,
      status: runComplete ? 'passed' : 'failed',
      valid: runComplete,
      abortReason: args.abortError?.message ?? null,
      timestamp: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      headful: args.headfulRun,
      browserWindowVisible: args.windowState.browserWindowVisible,
      documentVisibility: args.documentVisibility,
      testRepoPath: args.testRepoPath,
      config: args.config,
      headlineMs,
      warmupSummary,
      measuredSummary,
      warmupSamples: args.warmupSamples,
      measuredSamples: args.measuredSamples
    },
    warmupSummary,
    measuredSummary
  }
}
