import type { Stats } from 'node:fs'

const PROBE_TIMEOUT_MS = 1_000
const MAX_PENDING_PROBES = 2
export const UNVERIFIED_FS_PROBE = Symbol('unverified filesystem probe')

type ProbeValues = {
  stat: Stats
  lstat: Stats
  access: boolean
  dirs: string[]
  listing: Map<string, string>
  file: string
  realpath: string
}
type ProbeKind = keyof ProbeValues
type ProbeValue = ProbeValues[ProbeKind] | null
type ProbeResult = ProbeValue | typeof UNVERIFIED_FS_PROBE
type PendingProbe = {
  kind: ProbeKind
  result: Promise<ProbeResult>
  value?: ProbeValue
  timedOut: boolean
}

const pendingByPath = new Map<string, PendingProbe>()
let capacityChanged = Promise.withResolvers<void>()
let slowProbeSettled = Promise.withResolvers<void>()

function notifyCapacityChanged(): void {
  capacityChanged.resolve()
  capacityChanged = Promise.withResolvers<void>()
}

function startProbe(path: string, kind: ProbeKind, read: () => Promise<ProbeValue>): PendingProbe {
  const result = Promise.withResolvers<ProbeResult>()
  const probe: PendingProbe = { kind, result: result.promise, timedOut: false }
  pendingByPath.set(path, probe)
  const timer = setTimeout(() => {
    probe.timedOut = true
    result.resolve(UNVERIFIED_FS_PROBE)
    notifyCapacityChanged()
  }, PROBE_TIMEOUT_MS)
  void Promise.resolve()
    .then(read)
    .catch(() => null)
    .then((value) => {
      clearTimeout(timer)
      probe.value = value
      pendingByPath.delete(path)
      result.resolve(value)
      notifyCapacityChanged()
      if (probe.timedOut) {
        slowProbeSettled.resolve()
        slowProbeSettled = Promise.withResolvers<void>()
      }
    })
  return probe
}

export class InventoryFsProbes {
  private readonly slow: Map<string, PendingProbe>
  retryWhen?: Promise<void>

  constructor(previous?: InventoryFsProbes) {
    // Successor scans can use a slow probe's actual result once the native call settles.
    this.slow = new Map(previous?.slow)
  }

  read<K extends ProbeKind>(
    path: string,
    kind: K,
    read: () => Promise<ProbeValues[K] | null>
  ): Promise<ProbeValues[K] | null | typeof UNVERIFIED_FS_PROBE>
  async read(path: string, kind: ProbeKind, read: () => Promise<ProbeValue>): Promise<ProbeResult> {
    const key = JSON.stringify([path, kind])
    const recorded = this.slow.get(key)
    if (recorded?.value !== undefined) {
      return recorded.value
    }
    for (;;) {
      const pending = recorded ?? pendingByPath.get(path)
      if (pending?.kind === kind) {
        const result = await pending.result
        if (result !== UNVERIFIED_FS_PROBE) {
          return result
        }
        this.slow.set(key, pending)
        return pending.value === undefined ? this.defer() : pending.value
      }
      if (pending) {
        await pending.result
        if (pending.value === undefined) {
          return this.defer()
        }
      } else if (pendingByPath.size < MAX_PENDING_PROBES) {
        startProbe(path, kind, read)
      } else {
        if ([...pendingByPath.values()].every((probe) => probe.timedOut)) {
          return this.defer()
        }
        await capacityChanged.promise
      }
    }
  }

  private defer(): typeof UNVERIFIED_FS_PROBE {
    this.retryWhen ??= slowProbeSettled.promise
    return UNVERIFIED_FS_PROBE
  }
}
