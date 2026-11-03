import type { FileExplorerTreeRefreshOutcome } from './file-explorer-types'

export type FileExplorerDirLoadToken = {
  dirPath: string
  revision: number
  session: number
  promise: Promise<FileExplorerTreeRefreshOutcome>
  started: boolean
  observed: boolean
}
export type FileExplorerDirLoadSession = number
export type FileExplorerDirLoadTracker = ReturnType<typeof createFileExplorerDirLoadTracker>

/** Logical completion and publication ownership retire together, independently of transport. */
export function createFileExplorerDirLoadTracker(prepareReset?: () => void) {
  let session = 0
  let revision = 0
  const current = new Map<
    string,
    FileExplorerDirLoadToken & {
      resolve: (outcome: FileExplorerTreeRefreshOutcome) => void
      cleanup?: () => void
      flush?: () => void
    }
  >()
  const isCurrent = (token: FileExplorerDirLoadToken): boolean =>
    current.get(token.dirPath) === token
  const finish = (
    token: FileExplorerDirLoadToken,
    outcome: FileExplorerTreeRefreshOutcome
  ): void => {
    const operation = current.get(token.dirPath)
    if (operation !== token) {
      return
    }
    try {
      operation.cleanup?.()
    } finally {
      current.delete(token.dirPath)
      operation.resolve(outcome)
    }
  }
  return {
    begin: (
      dirPath: string,
      cleanup?: () => void,
      flush?: () => void
    ): FileExplorerDirLoadToken => {
      const previous = current.get(dirPath)
      if (previous) {
        finish(previous, 'superseded')
      }
      let resolve!: (outcome: FileExplorerTreeRefreshOutcome) => void
      const promise = new Promise<FileExplorerTreeRefreshOutcome>((done) => {
        resolve = done
      })
      const operation = {
        dirPath,
        revision: ++revision,
        session,
        promise,
        resolve,
        cleanup,
        flush,
        started: false,
        observed: false
      }
      current.set(dirPath, operation)
      return operation
    },
    isCurrent,
    finish,
    retire: (token: FileExplorerDirLoadToken) => finish(token, 'superseded'),
    get: (dirPath: string): FileExplorerDirLoadToken | undefined => current.get(dirPath),
    observe: (token: FileExplorerDirLoadToken): Promise<FileExplorerTreeRefreshOutcome> => {
      if (isCurrent(token)) {
        token.observed = true
        current.get(token.dirPath)?.flush?.()
      }
      return token.promise
    },
    getSession: () => session,
    isSessionCurrent: (snapshot: FileExplorerDirLoadSession) => snapshot === session,
    reset: () => {
      let failure: { error: unknown } | undefined
      try {
        prepareReset?.()
      } catch (error) {
        failure = { error }
      }
      try {
        for (const token of current.values()) {
          try {
            finish(token, 'superseded')
          } catch (error) {
            failure ??= { error }
          }
        }
      } finally {
        session += 1
      }
      if (failure) {
        throw failure.error
      }
    }
  }
}
