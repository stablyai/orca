import React from 'react'
import type { HostedSandboxTiming } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import type { VmBuildStepId } from './vm-build-steps'

/** p50 drives the "usually ~Ns" hint; past p95 the step reads as slower than usual. */
export type VmBuildStepTiming = Pick<HostedSandboxTiming, 'p50Ms' | 'p95Ms'>

export type VmBuildStepTimings = Partial<Record<VmBuildStepId, VmBuildStepTiming>>

/** With no measured p95 yet, a running step reads as slow only past this. */
export const SLOW_WITHOUT_MEASURE_MS = 30_000

const NONE: VmBuildStepTimings = {}
const STORAGE_KEY = 'orca.cloud.startSamples.v2'
/** A rolling window: one slow day doesn't stick. */
const MAX_SAMPLES = 20
/** Fewer starts than this say nothing about "usually". */
const MIN_SAMPLES = 5
/** Below this many, one outlier would swing p95: the threshold is at least 1.5x the median. */
const SMALL_SAMPLE = 10

/**
 * Kinds of start time separately: a fresh clone and a boot from an environment build (repo prebuilt)
 * differ. Wakes don't use this sheet (CloudWakingOverlay), so they never land here.
 */
export type CloudStartKind = 'clone' | 'update'

// JA-11: the hint used the control plane's create_ms (write-ahead row to orcad ready, ~2-3 s), while
// "Start sandbox" on this sheet runs end to end (token, entitlement, VM, orcad, network: ~6 s). A
// normal start read as "Taking longer than usual". So the hint is this computer's own measurement of
// the very step it labels: the last starts' durations per kind, kept locally (durations only).
type Samples = Record<CloudStartKind, number[]>
let samples: Samples | null = null
const recorded = new Set<string>()

function clean(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((v): v is number => typeof v === 'number' && v > 0).slice(-MAX_SAMPLES)
    : []
}

function load(): Samples {
  if (samples) {
    return samples
  }
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')
    const record = parsed && typeof parsed === 'object' ? parsed : {}
    samples = {
      clone: clean('clone' in record ? record.clone : []),
      update: clean('update' in record ? record.update : [])
    }
  } catch {
    samples = { clone: [], update: [] }
  }
  return samples
}

/** One finished "Start sandbox" of `creationId`, measured on this sheet; each creation counts once. */
export function recordCloudStartSample(creationId: string, kind: CloudStartKind, ms: number): void {
  if (recorded.has(creationId) || !(ms > 0)) {
    return
  }
  recorded.add(creationId)
  const current = load()
  samples = { ...current, [kind]: [...current[kind], Math.round(ms)].slice(-MAX_SAMPLES) }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(samples))
  } catch {
    // Storage full or unavailable: the hint just stays off.
  }
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!
}

/** p50/p95 of this computer's recent starts of `kind`; null until there are enough of them. */
export function measuredCloudStart(kind: CloudStartKind): VmBuildStepTiming | null {
  const values = [...load()[kind]].sort((a, b) => a - b)
  if (values.length < MIN_SAMPLES) {
    return null
  }
  const p50Ms = percentile(values, 0.5)
  const p95Ms = percentile(values, 0.95)
  return {
    p50Ms,
    p95Ms: values.length <= SMALL_SAMPLE ? Math.max(p95Ms, Math.round(1.5 * p50Ms)) : p95Ms
  }
}

/**
 * Measured Orca Cloud step timings for a start of `kind` (unknown until the boot plan answers: no
 * hint meanwhile); empty for VM recipes and until enough starts of that kind were measured.
 */
export function useVmBuildStepTimings(
  cloud: boolean,
  kind: CloudStartKind | null = null
): VmBuildStepTimings {
  // Read once per kind and sheet: a start that finishes while it is open must not move its own hint.
  const timings = React.useMemo<VmBuildStepTimings>(() => {
    const start = cloud && kind ? measuredCloudStart(kind) : null
    return start ? { provision: start } : NONE
  }, [cloud, kind])
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
