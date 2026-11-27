import { accessSync, constants, readFileSync, readdirSync, statSync } from 'node:fs'
import { access, lstat, open, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isMissingPathError,
  isPathPermissionError,
  UNVERIFIED_FS_PROBE,
  type InstallDirectoryListing,
  type InventoryFsProbes
} from './inventory-fs-probes'
import {
  hasNativeExecutableMagic,
  isNativeExecutable,
  NATIVE_EXECUTABLE_HEAD_BYTES
} from '../launch/cli-runtime-pairing-inputs'

/** One filesystem read a CLI lookup needs; lookups yield these so sync and async callers share one walk. */
export type CliFsRead =
  | { kind: 'runnable'; platform: NodeJS.Platform; path: string }
  /** A regular file's contents, else null. */
  | { kind: 'file'; path: string }
  /** Subdirectory names, else null. */
  | { kind: 'dirs'; path: string }
  /** Whether the file is a compiled binary rather than a script. */
  | { kind: 'native'; path: string }
export type CliFsReadResult = boolean | string | string[] | null
export type CliFsReads<T> = Generator<CliFsRead, T, CliFsReadResult>

export function isRunnableCommand(platform: NodeJS.Platform, candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) {
      return false
    }
    if (platform === 'win32') {
      return true
    }
    // Skip nonexecutables/placeholders now so GUI probing reaches a runnable CLI instead of later EACCES/EISDIR.
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function isRunnableCommandAsync(
  platform: NodeJS.Platform,
  candidate: string
): Promise<boolean> {
  try {
    if (!(await stat(candidate)).isFile()) {
      return false
    }
    if (platform !== 'win32') {
      await access(candidate, constants.X_OK)
    }
    return true
  } catch {
    return false
  }
}

function readSync(read: CliFsRead): CliFsReadResult {
  try {
    switch (read.kind) {
      case 'runnable':
        return isRunnableCommand(read.platform, read.path)
      case 'file':
        return statSync(read.path).isFile() ? readFileSync(read.path, 'utf8') : null
      case 'dirs':
        return readdirSync(read.path, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      case 'native':
        return isNativeExecutable(read.path)
    }
  } catch {
    return null
  }
}

async function isNativeExecutableAsync(path: string): Promise<boolean> {
  const file = await open(path, 'r')
  try {
    const head = Buffer.alloc(NATIVE_EXECUTABLE_HEAD_BYTES)
    const { bytesRead } = await file.read(head, 0, head.length, 0)
    return hasNativeExecutableMagic(head.subarray(0, bytesRead))
  } finally {
    await file.close().catch(() => {})
  }
}

export type CliFsProbeOptions = {
  probes: InventoryFsProbes
  onUnverified: () => void
  acceptsExecutableTarget?: (target: string) => Promise<boolean | typeof UNVERIFIED_FS_PROBE>
  readDirectories?: (
    path: string
  ) => Promise<InstallDirectoryListing | null | typeof UNVERIFIED_FS_PROBE>
}

async function readInstallDirectoryNames(path: string): Promise<string[]> {
  const directories: string[] = []
  for (const name of await readdir(path)) {
    try {
      if ((await lstat(join(path, name))).isDirectory()) {
        directories.push(name)
      }
    } catch (error) {
      if (!isMissingPathError(error) && !isPathPermissionError(error)) {
        throw error
      }
    }
  }
  return directories
}

async function readInstallDirectories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch (error) {
    if (
      !isMissingPathError(error) ||
      (typeof error === 'object' && error !== null && 'path' in error && error.path === path)
    ) {
      throw error
    }
    // On DT_UNKNOWN filesystems a vanished entry can fail the Dirent conversion.
    return readInstallDirectoryNames(path)
  }
}

async function readAsync(
  read: CliFsRead,
  options?: CliFsProbeOptions
): Promise<CliFsReadResult | typeof UNVERIFIED_FS_PROBE> {
  const probes = options?.probes
  try {
    switch (read.kind) {
      case 'runnable': {
        if (!probes) {
          return await isRunnableCommandAsync(read.platform, read.path)
        }
        const result = await probes.executableFile(read.path, read.platform === 'win32')
        const acceptsTarget = options?.acceptsExecutableTarget
        if (result !== 'file' || !acceptsTarget) {
          return result === UNVERIFIED_FS_PROBE ? result : result === 'file'
        }
        const target = await probes.realPath(read.path)
        return target === UNVERIFIED_FS_PROBE
          ? target
          : target !== null && (await acceptsTarget(target))
      }
      case 'file': {
        const stats = await (probes
          ? probes.read(read.path, 'stat', () => stat(read.path))
          : stat(read.path))
        if (stats === UNVERIFIED_FS_PROBE || !stats?.isFile()) {
          return stats === UNVERIFIED_FS_PROBE ? stats : null
        }
        return await (probes
          ? probes.read(read.path, 'file', () => readFile(read.path, 'utf8'))
          : readFile(read.path, 'utf8'))
      }
      case 'dirs': {
        if (!options?.readDirectories) {
          return await readInstallDirectories(read.path)
        }
        const listing = await options.readDirectories(read.path)
        if (listing === UNVERIFIED_FS_PROBE) {
          return listing
        }
        if (listing?.uncertain) {
          options.onUnverified()
        }
        return listing?.names ?? null
      }
      case 'native':
        return await isNativeExecutableAsync(read.path)
    }
  } catch {
    return null
  }
}

export function runCliFsReadsSync<T>(reads: CliFsReads<T>): T {
  let step = reads.next()
  while (!step.done) {
    step = reads.next(readSync(step.value))
  }
  return step.value
}

export async function runCliFsReadsAsync<T>(
  reads: CliFsReads<T>,
  options?: CliFsProbeOptions
): Promise<T> {
  let step = reads.next()
  while (!step.done) {
    const result = await readAsync(step.value, options)
    if (result === UNVERIFIED_FS_PROBE) {
      options?.onUnverified()
    }
    step = reads.next(result === UNVERIFIED_FS_PROBE ? null : result)
  }
  return step.value
}
