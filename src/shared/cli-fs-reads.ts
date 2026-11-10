import { accessSync, constants, readFileSync, readdirSync, statSync } from 'node:fs'
import { access, readdir, readFile, stat } from 'node:fs/promises'

/** One filesystem read a CLI lookup needs; lookups yield these so sync and async callers share one walk. */
export type CliFsRead =
  | { kind: 'runnable'; platform: NodeJS.Platform; path: string }
  /** A regular file's contents, else null. */
  | { kind: 'file'; path: string }
  /** Subdirectory names, else null. */
  | { kind: 'dirs'; path: string }
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

async function isRunnableCommandAsync(
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
    }
  } catch {
    return null
  }
}

async function readAsync(read: CliFsRead): Promise<CliFsReadResult> {
  try {
    switch (read.kind) {
      case 'runnable':
        return await isRunnableCommandAsync(read.platform, read.path)
      case 'file':
        return (await stat(read.path)).isFile() ? await readFile(read.path, 'utf8') : null
      case 'dirs':
        return (await readdir(read.path, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
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

export async function runCliFsReadsAsync<T>(reads: CliFsReads<T>): Promise<T> {
  let step = reads.next()
  while (!step.done) {
    step = reads.next(await readAsync(step.value))
  }
  return step.value
}
