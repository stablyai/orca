import { describe, expect, it } from 'vitest'
import { buildBenchmarkReport, summarizeSamples } from './terminal-split-activation-latency-report'
import {
  createSplitLatencySample,
  mergeSplitLatencyMainProbeEvents,
  type RendererPhaseStamps,
  type SplitLatencyMainProbeEvent
} from './terminal-split-activation-latency-phases'

function createRendererStamps(): RendererPhaseStamps {
  return {
    marker: 'echo-marker',
    sourcePaneId: 1,
    sourcePtyId: 'pty-source',
    newPaneId: 2,
    newPtyId: 'pty-child',
    rendererTimeOriginEpochMs: 1_000,
    keydownAtMs: 10,
    focusAtMs: 20,
    cwdRequestAtMs: null,
    cwdSettledAtMs: null,
    ptySpawnRequestAtMs: null,
    ptySpawnResultAtMs: null,
    ptyBoundAtMs: 82,
    fixtureUnlockRequestedAtMs: 83,
    fixtureUnlockIpcWriteAtMs: null,
    fixtureUnlockIpcWriteChannel: null,
    fixtureReadyParsedAtMs: 100,
    inputAtMs: 101,
    firstEchoAtMs: 103
  }
}

function createMainProbeEvents(): SplitLatencyMainProbeEvent[] {
  return [
    {
      kind: 'cwd-request',
      operationId: 99,
      atEpochMs: 1_010,
      ptyId: 'pty-other',
      writeChannel: null
    },
    {
      kind: 'cwd-request',
      operationId: 1,
      atEpochMs: 1_011,
      ptyId: 'pty-source',
      writeChannel: null
    },
    {
      kind: 'cwd-settled',
      operationId: 1,
      atEpochMs: 1_060,
      ptyId: 'pty-source',
      writeChannel: null
    },
    {
      kind: 'pty-spawn-request',
      operationId: 2,
      atEpochMs: 1_061,
      ptyId: null,
      writeChannel: null
    },
    {
      kind: 'pty-spawn-result',
      operationId: 3,
      atEpochMs: 1_070,
      ptyId: 'pty-other',
      writeChannel: null
    },
    {
      kind: 'pty-spawn-result',
      operationId: 2,
      atEpochMs: 1_080,
      ptyId: 'pty-child',
      writeChannel: null
    },
    {
      kind: 'pty-write-cr',
      operationId: null,
      atEpochMs: 1_081,
      ptyId: 'pty-other',
      writeChannel: 'pty:write'
    },
    {
      kind: 'pty-write-cr',
      operationId: null,
      atEpochMs: 1_084,
      ptyId: 'pty-child',
      writeChannel: 'pty:writeAccepted'
    }
  ]
}

describe('terminal split activation latency report', () => {
  it('attributes main-process phases to the matching source and child PTYs', () => {
    const stamps = mergeSplitLatencyMainProbeEvents(createRendererStamps(), createMainProbeEvents())
    const sample = createSplitLatencySample({
      phase: 'measured',
      iteration: 0,
      stamps,
      completedWithinTimeout: true,
      paneCountAfterProbe: 2,
      ptyExitObserved: true,
      cleanupError: null
    })

    expect(sample).toMatchObject({
      cwdRequestAtMs: 11,
      cwdSettledAtMs: 60,
      ptySpawnRequestAtMs: 61,
      ptySpawnResultAtMs: 80,
      fixtureUnlockIpcWriteAtMs: 84,
      fixtureUnlockIpcWriteChannel: 'pty:writeAccepted',
      shortcutToCwdRequestMs: 1,
      cwdLookupMs: 49,
      cwdSettleToPtySpawnRequestMs: 1,
      ptySpawnRequestToResultMs: 19,
      ptySpawnResultToBindMs: 2,
      fixtureUnlockRequestToIpcWriteMs: 1,
      fixtureUnlockIpcWriteToReadyParseMs: 16,
      success: true,
      missing: []
    })
  })

  it('embeds revision identity and summarizes the attributed phases', () => {
    const stamps = mergeSplitLatencyMainProbeEvents(createRendererStamps(), createMainProbeEvents())
    const sample = createSplitLatencySample({
      phase: 'measured',
      iteration: 0,
      stamps,
      completedWithinTimeout: true,
      paneCountAfterProbe: 2,
      ptyExitObserved: true,
      cleanupError: null
    })
    const revision = { headSha: 'a'.repeat(40), dirty: false }
    const result = buildBenchmarkReport({
      label: 'candidate',
      revision,
      headfulRun: true,
      windowState: { browserWindowVisible: true, windowCount: 1 },
      documentVisibility: 'visible',
      testRepoPath: '/tmp/repo',
      warmupSamples: [{ ...sample, phase: 'warmup' }],
      measuredSamples: [sample],
      abortError: null,
      config: {
        warmupCycles: 1,
        measuredCycles: 1,
        maxMeasuredCycles: 200,
        testTimeoutMs: 30_000,
        splitChord: 'Meta+d',
        closeChord: 'Meta+w',
        sampleTimeoutMs: 15_000,
        cleanupTimeoutMs: 15_000,
        processCwdCacheExpiryWaitMs: 1_650
      }
    })

    expect(result.report).toMatchObject({
      schemaVersion: 2,
      revision,
      status: 'passed',
      valid: true
    })
    expect(result.measuredSummary.distributions.cwdLookupMs.p50).toBe(49)
    expect(result.measuredSummary.distributions.ptySpawnRequestToResultMs.p50).toBe(19)
    expect(result.measuredSummary.distributions.fixtureUnlockIpcWriteToReadyParseMs.p50).toBe(16)
  })

  it('invalidates a sample when the actual fixture-unlock IPC write is missing', () => {
    const stamps = mergeSplitLatencyMainProbeEvents(
      createRendererStamps(),
      createMainProbeEvents().filter((event) => event.kind !== 'pty-write-cr')
    )
    const sample = createSplitLatencySample({
      phase: 'measured',
      iteration: 0,
      stamps,
      completedWithinTimeout: true,
      paneCountAfterProbe: 2,
      ptyExitObserved: true,
      cleanupError: null
    })

    expect(sample.success).toBe(false)
    expect(sample.missing).toContain('fixture-unlock-ipc-write')
    expect(summarizeSamples([sample], 1).counts.missingEvents.fixtureUnlockIpcWrite).toBe(1)
  })
})
