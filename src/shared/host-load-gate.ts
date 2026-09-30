export const HOST_LOAD_EXCEEDED_CODE = 'host_load_exceeded'

export type HostLoadSample = {
  cpuCoreCount: number
  loadAverage1m: number
}

export type HostLoadGateVerdict = HostLoadSample & {
  /** 1-minute load average divided by the core count; 1.0 means every core is busy. */
  loadRatio: number
  maxLoad: number
  exceeded: boolean
}

export function isValidMaxLoad(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export function evaluateHostLoadGate(sample: HostLoadSample, maxLoad: number): HostLoadGateVerdict {
  const cpuCoreCount = Math.max(1, Math.floor(sample.cpuCoreCount))
  const loadAverage1m = Number.isFinite(sample.loadAverage1m)
    ? Math.max(0, sample.loadAverage1m)
    : 0
  const loadRatio = loadAverage1m / cpuCoreCount
  return { cpuCoreCount, loadAverage1m, loadRatio, maxLoad, exceeded: loadRatio > maxLoad }
}

export function hostLoadExceededMessage(verdict: HostLoadGateVerdict): string {
  return (
    `Host load ${verdict.loadRatio.toFixed(2)} per core ` +
    `(1-minute average ${verdict.loadAverage1m.toFixed(2)} on ${verdict.cpuCoreCount} cores) ` +
    `exceeds --max-load ${verdict.maxLoad}. No effects were applied.`
  )
}

export const HOST_LOAD_EXCEEDED_NEXT_STEPS: readonly string[] = [
  'Leave the Task in the ready queue and continue waiting on running workers with `check --wait`.',
  'Retry the same worker-start after the next worker_done or wait timeout; the Task is unchanged.',
  'Start it now only if the work is light: repeat the command without --max-load or with a higher ratio.'
]
