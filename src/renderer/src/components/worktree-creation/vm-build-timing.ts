import React from 'react'
import type { HostedSandboxTiming } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import type { VmBuildStepId } from './vm-build-steps'

/** p50 drives the "usually ~Ns" hint; past p95 the step reads as slower than usual. */
export type VmBuildStepTiming = Pick<HostedSandboxTiming, 'p50Ms' | 'p95Ms'>

export type VmBuildStepTimings = Partial<Record<VmBuildStepId, VmBuildStepTiming>>

const NONE: VmBuildStepTimings = {}

// Each new build sheet asks again: the control plane re-measures recent sandbox starts
// (GET /v1/config) and main caches the answer for 5 minutes. The last answer shows meanwhile.
let measured: VmBuildStepTimings | null = null
let pending: Promise<VmBuildStepTimings> | null = null

function loadMeasuredTimings(): Promise<VmBuildStepTimings> {
  pending ??= (window.api.orcaCloudWorkspace?.getConfig?.() ?? Promise.resolve(null))
    .then((config) => {
      if (!config) {
        // Unreachable now says nothing about later: the next sheet asks again.
        pending = null
        return NONE
      }
      // Only "Start sandbox" is measured. Without a measurement there is no hint, never a guess.
      measured = config.createTiming ? { provision: config.createTiming } : NONE
      pending = null
      return measured
    })
    .catch(() => {
      pending = null
      return NONE
    })
  return pending
}

/** Measured Orca Cloud step timings; empty for VM recipes and until the control plane answers. */
export function useVmBuildStepTimings(cloud: boolean): VmBuildStepTimings {
  const [timings, setTimings] = React.useState<VmBuildStepTimings>(() =>
    cloud ? (measured ?? NONE) : NONE
  )
  React.useEffect(() => {
    if (!cloud) {
      return
    }
    let live = true
    void loadMeasuredTimings().then((next) => {
      if (live) {
        setTimings(next)
      }
    })
    return () => {
      live = false
    }
  }, [cloud])
  return cloud ? timings : NONE
}

/** The hint in whole seconds, never "~0s". */
export function typicalStepSeconds(timing: VmBuildStepTiming): number {
  return Math.max(1, Math.round(timing.p50Ms / 1000))
}
