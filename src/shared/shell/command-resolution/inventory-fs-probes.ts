import type { Stats } from 'node:fs'
import { access, constants } from 'node:fs/promises'
import { waitForPromiseWithSignal } from '../../concurrency/abort-signal-reason'
import { PrioritySemaphore } from '../../concurrency/priority-semaphore'

export const UNVERIFIED_FS_PROBE = Symbol('unverified filesystem probe')
const SKIPPED_FS_PROBE = Symbol('filesystem probe canceled before admission')

type ProbeValues = {
  stat: Stats
  access: boolean
  dirs: string[]
  listing: Map<string, string>
  file: string
  realpath: string
}
type ProbeKind = keyof ProbeValues
type ProbeValue = ProbeValues[ProbeKind] | null
type ProbeResult = ProbeValue | typeof UNVERIFIED_FS_PROBE
type PendingProbe = { kind: ProbeKind; result: Promise<ProbeResult | typeof SKIPPED_FS_PROBE> }

const pendingByPath = new Map<string, PendingProbe>()
const overrideLane = new PrioritySemaphore(1)
const inventoryLane = new PrioritySemaphore(2)

export function isPathPermissionError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'EACCES' || error.code === 'EPERM')
  )
}

export function isMissingPathError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

export class InventoryFsProbes {
  private readonly lane: PrioritySemaphore

  constructor(
    readonly signal: AbortSignal,
    lane: 'inventory' | 'override' = 'inventory'
  ) {
    this.lane = lane === 'override' ? overrideLane : inventoryLane
  }

  private async readWithPermit(
    read: () => Promise<ProbeResult>
  ): Promise<ProbeResult | typeof SKIPPED_FS_PROBE> {
    const release = await this.lane.acquire(0, this.signal).catch(() => undefined)
    if (!release) {
      return SKIPPED_FS_PROBE
    }
    try {
      return this.signal.aborted ? SKIPPED_FS_PROBE : await read()
    } finally {
      release()
    }
  }

  read<K extends ProbeKind>(
    path: string,
    kind: K,
    read: () => Promise<ProbeValues[K] | null | typeof UNVERIFIED_FS_PROBE>
  ): Promise<ProbeValues[K] | null | typeof UNVERIFIED_FS_PROBE>
  async read(
    path: string,
    kind: ProbeKind,
    read: () => Promise<ProbeResult>
  ): Promise<ProbeResult> {
    while (!this.signal.aborted) {
      let pending = pendingByPath.get(path)
      if (!pending) {
        const result = this.readWithPermit(read)
          .catch((error: unknown): null | typeof UNVERIFIED_FS_PROBE =>
            isMissingPathError(error) ||
            ((kind === 'stat' || kind === 'dirs') && isPathPermissionError(error))
              ? null
              : UNVERIFIED_FS_PROBE
          )
          .finally(() => pendingByPath.delete(path))
        pending = { kind, result }
        pendingByPath.set(path, pending)
      }
      const value = await waitForPromiseWithSignal(pending.result, this.signal).catch(
        (): typeof UNVERIFIED_FS_PROBE => UNVERIFIED_FS_PROBE
      )
      if (value !== SKIPPED_FS_PROBE && pending.kind === kind) {
        return value
      }
    }
    return UNVERIFIED_FS_PROBE
  }

  executableAccess(
    path: string,
    stats: Stats
  ): Promise<boolean | null | typeof UNVERIFIED_FS_PROBE> {
    return this.read(path, 'access', async () => {
      try {
        await access(path, constants.X_OK)
        return true
      } catch (error) {
        // A denial on a file with execute bits can come from an inaccessible parent.
        if (
          isMissingPathError(error) ||
          ((stats.mode & 0o111) === 0 && isPathPermissionError(error))
        ) {
          return false
        }
        throw error
      }
    })
  }
}
