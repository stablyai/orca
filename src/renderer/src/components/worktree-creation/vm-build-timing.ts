import React from 'react'
import type { HostedSandboxTiming } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import type { VmBuildStepId } from './vm-build-steps'

/** p50 drives the "usually ~Ns" hint; past p95 the step reads as slower than usual. */
export type VmBuildStepTiming = Pick<HostedSandboxTiming, 'p50Ms' | 'p95Ms'>

export type VmBuildStepTimings = Partial<Record<VmBuildStepId, VmBuildStepTiming>>

/** With no measured p95 yet, a running step reads as slow only past this. */
export const SLOW_WITHOUT_MEASURE_MS = 30_000

const NONE: VmBuildStepTimings = {}
const STORAGE_KEY = 'orca.cloud.startSamples.v1'
const MAX_SAMPLES = 40
/** Fewer starts than this say nothing about "usually". */
const MIN_SAMPLES = 5

// JA-11: the hint used the control plane's create_ms (write-ahead row to orcad ready, ~2-3 s), while
// "Start sandbox" on this sheet runs end to end (token, entitlement, VM, orcad, network: ~6 s). A
// normal start read as "Taking longer than usual". So the hint is this computer's own measurement of
// the very step it labels: the last starts' durations, kept locally (durations only, nothing else).
let samples: number[] | null = null
const recorded = new Set<string>()

function load(): number[] {
  if (samples) {
    return samples
  }
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]')
    samples = Array.isArray(parsed)
      ? parsed.filter((v): v is number => typeof v === 'number' && v > 0).slice(-MAX_SAMPLES)
      : []
  } catch {
    samples = []
  }
  return samples
}

/** One finished "Start sandbox" of `creationId`, measured on this sheet; each creation counts once. */
export function recordCloudStartSample(creationId: string, ms: number): void {
  if (recorded.has(creationId) || !(ms > 0)) {
    return
  }
  recorded.add(creationId)
  samples = [...load(), Math.round(ms)].slice(-MAX_SAMPLES)
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(samples))
  } catch {
    // Storage full or unavailable: the hint just stays off.
  }
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!
}

/** p50/p95 of this computer's recent starts; null until there are enough of them. */
export function measuredCloudStart(): VmBuildStepTiming | null {
  const values = [...load()].sort((a, b) => a - b)
  if (values.length < MIN_SAMPLES) {
    return null
  }
  return { p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95) }
}

/** Measured Orca Cloud step timings; empty for VM recipes and until enough starts were measured. */
export function useVmBuildStepTimings(cloud: boolean): VmBuildStepTimings {
  // Read once per sheet: a start that finishes while it is open must not move its own hint.
  const [timings] = React.useState<VmBuildStepTimings>(() => {
    const start = cloud ? measuredCloudStart() : null
    return start ? { provision: start } : NONE
  })
  return cloud ? timings : NONE
}

/** The hint in whole seconds, never "~0s". */
export function typicalStepSeconds(timing: VmBuildStepTiming): number {
  return Math.max(1, Math.round(timing.p50Ms / 1000))
}

/** Tests: forget what this module read or recorded. */
export function resetCloudStartSamplesForTests(): void {
  samples = null
  recorded.clear()
}
