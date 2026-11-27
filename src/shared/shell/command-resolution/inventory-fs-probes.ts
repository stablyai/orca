import type { Stats } from 'node:fs'
import { access, constants, realpath, stat } from 'node:fs/promises'
import { waitForPromiseWithSignal } from '../../concurrency/abort-signal-reason'
import { PrioritySemaphore } from '../../concurrency/priority-semaphore'

export const UNVERIFIED_FS_PROBE = Symbol('unverified filesystem probe')
export type InstallDirectoryListing = { names: string[]; uncertain: boolean }
type ExecutableFile = 'file' | 'other'

type ProbeValues = {
  stat: Stats
  posixExecutable: ExecutableFile
  windowsExecutable: ExecutableFile
  dirs: InstallDirectoryListing
  listing: Map<string, string>
  file: string
  realpath: string
}
type ProbeKind = keyof ProbeValues
type ProbeValue = ProbeValues[ProbeKind] | null
type ProbeResult = ProbeValue | typeof UNVERIFIED_FS_PROBE
const pendingByKind = new Map<ProbeKind, Map<string, Promise<ProbeResult>>>()
const installerLane = new PrioritySemaphore(2)

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

export async function probeExecutableFile(
  path: string,
  isWin: boolean
): Promise<ExecutableFile | null | typeof UNVERIFIED_FS_PROBE> {
  let stats: Stats
  try {
    stats = await stat(path)
  } catch (error) {
    return isMissingPathError(error) || isPathPermissionError(error) ? null : UNVERIFIED_FS_PROBE
  }
  if (isWin || stats.isDirectory()) {
    return stats.isFile() ? 'file' : null
  }
  try {
    await access(path, constants.X_OK)
    return stats.isFile() ? 'file' : 'other'
  } catch (error) {
    // A denial on a file with execute bits can come from an inaccessible parent.
    return isMissingPathError(error) || ((stats.mode & 0o111) === 0 && isPathPermissionError(error))
      ? null
      : UNVERIFIED_FS_PROBE
  }
}

export class InventoryFsProbes {
  private readonly lane?: PrioritySemaphore

  constructor(
    readonly signal: AbortSignal,
    lane: 'path' | 'installer' = 'path'
  ) {
    this.lane = lane === 'installer' ? installerLane : undefined
  }

  private async readWithPermit(
    lane: PrioritySemaphore,
    pending: Map<string, Promise<ProbeResult>>,
    path: string,
    kind: ProbeKind,
    read: () => Promise<ProbeResult>
  ): Promise<ProbeResult> {
    const release = await lane.acquire(0, this.signal)
    if (this.signal.aborted) {
      release()
      return UNVERIFIED_FS_PROBE
    }
    const joined = pending.get(path)
    if (joined) {
      release()
      return await joined
    }
    try {
      return await issueProbe(pending, path, kind, read)
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
    if (this.signal.aborted) {
      return UNVERIFIED_FS_PROBE
    }
    const pending = pendingByKind.get(kind) ?? new Map<string, Promise<ProbeResult>>()
    pendingByKind.set(kind, pending)
    const lane = kind === 'dirs' ? undefined : this.lane
    const result =
      pending.get(path) ??
      (lane
        ? this.readWithPermit(lane, pending, path, kind, read)
        : issueProbe(pending, path, kind, read))
    return waitForPromiseWithSignal(result, this.signal).catch(
      (): typeof UNVERIFIED_FS_PROBE => UNVERIFIED_FS_PROBE
    )
  }

  realPath(path: string): Promise<string | null | typeof UNVERIFIED_FS_PROBE> {
    return this.read(path, 'realpath', () => realpath(path))
  }

  executableFile(
    path: string,
    isWin: boolean
  ): Promise<ExecutableFile | null | typeof UNVERIFIED_FS_PROBE> {
    return this.read(path, isWin ? 'windowsExecutable' : 'posixExecutable', () =>
      probeExecutableFile(path, isWin)
    )
  }
}

function issueProbe(
  pending: Map<string, Promise<ProbeResult>>,
  path: string,
  kind: ProbeKind,
  read: () => Promise<ProbeResult>
): Promise<ProbeResult> {
  const result = (async () => read())()
    .catch((error: unknown): null | typeof UNVERIFIED_FS_PROBE =>
      isMissingPathError(error) ||
      ((kind === 'stat' || kind === 'dirs') && isPathPermissionError(error))
        ? null
        : UNVERIFIED_FS_PROBE
    )
    .finally(() => pending.delete(path))
  pending.set(path, result)
  return result
}
