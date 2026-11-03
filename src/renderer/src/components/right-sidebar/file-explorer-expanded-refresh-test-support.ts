import type { DirEntry } from '../../../../shared/filesystem-entry-types'
import type { FileExplorerLoadingDirsUpdater } from './file-explorer-dir-load-state'

export function hasPropertyKey<T extends object>(target: T, key: PropertyKey): key is keyof T {
  return key in target
}

export function createLoadingDirPathsRecorder(): {
  updateLoadingDirPaths: FileExplorerLoadingDirsUpdater
  isLoading: (dirPath: string) => boolean
} {
  let loadingDirPaths: ReadonlySet<string> = new Set<string>()
  return {
    updateLoadingDirPaths: (update) => {
      loadingDirPaths = update(loadingDirPaths)
    },
    isLoading: (dirPath: string) => loadingDirPaths.has(dirPath)
  }
}

export function entry(name: string, isDirectory = false): DirEntry {
  return { name, isDirectory, isSymlink: false }
}

export function emptyReadError(): Error {
  const error = new Error('directory read failed')
  error.message = ''
  return error
}

export function deferredListing() {
  let resolve!: (value: { entries: DirEntry[]; operationOwner: { kind: 'local' } }) => void
  let reject!: (error: Error) => void
  const promise = new Promise<{ entries: DirEntry[]; operationOwner: { kind: 'local' } }>(
    (yes, no) => {
      resolve = yes
      reject = no
    }
  )
  return { promise, resolve, reject }
}
export const flushWorkers = async () => {
  // A bounded number of turns drains queued slots; no rejection/retry spin is installed.
  for (let i = 0; i < 12; i++) {
    await Promise.resolve()
  }
}
