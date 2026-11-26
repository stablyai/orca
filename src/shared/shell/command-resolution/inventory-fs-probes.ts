import type { Stats } from 'node:fs'
import { access, constants } from 'node:fs/promises'
import { waitForPromiseWithSignal } from '../../concurrency/abort-signal-reason'

export const UNVERIFIED_FS_PROBE = Symbol('unverified filesystem probe')

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
type PendingProbe = { kind: ProbeKind; result: Promise<ProbeResult> }

const pendingByPath = new Map<string, PendingProbe>()

export function isMissingPathError(error: unknown, nonExecutable = false): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'ENOENT' ||
      error.code === 'ENOTDIR' ||
      (nonExecutable && (error.code === 'EACCES' || error.code === 'EPERM')))
  )
}

export class InventoryFsProbes {
  constructor(private readonly signal: AbortSignal) {}

  read<K extends ProbeKind>(
    path: string,
    kind: K,
    read: () => Promise<ProbeValues[K] | null>
  ): Promise<ProbeValues[K] | null | typeof UNVERIFIED_FS_PROBE>
  async read(path: string, kind: ProbeKind, read: () => Promise<ProbeValue>): Promise<ProbeResult> {
    while (!this.signal.aborted) {
      let pending = pendingByPath.get(path)
      if (!pending) {
        const result = Promise.resolve()
          .then(read)
          .catch((error: unknown): null | typeof UNVERIFIED_FS_PROBE =>
            isMissingPathError(error) ? null : UNVERIFIED_FS_PROBE
          )
          .finally(() => pendingByPath.delete(path))
        pending = { kind, result }
        pendingByPath.set(path, pending)
      }
      const value = await waitForPromiseWithSignal(pending.result, this.signal).catch(
        (): typeof UNVERIFIED_FS_PROBE => UNVERIFIED_FS_PROBE
      )
      if (pending.kind === kind) {
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
        if (isMissingPathError(error, (stats.mode & 0o111) === 0)) {
          return false
        }
        throw error
      }
    })
  }
}
