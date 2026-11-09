import type { VmBuildStepId } from './vm-build-steps'

/** p50 drives the "usually ~Ns" hint; past p95 the step reads as slower than usual. */
export type VmBuildStepTiming = { p50Ms: number; p95Ms: number }

/**
 * Measured Orca Cloud timings (dev, warm pool on): create p50 2.9 s / p95 4.0 s, of which the VM is
 * ~0.26 s and orcad 2.1 s / 3.4 s; wake p50 4.7 s / p95 7.3 s. Steps without a measurement show no
 * hint rather than a guess. Tune here.
 */
export const ORCA_CLOUD_STEP_TIMING: Partial<Record<VmBuildStepId, VmBuildStepTiming>> = {
  provision: { p50Ms: 2_900, p95Ms: 4_000 }
}

export function vmBuildStepTiming(stepId: VmBuildStepId, cloud: boolean): VmBuildStepTiming | null {
  return cloud ? (ORCA_CLOUD_STEP_TIMING[stepId] ?? null) : null
}
