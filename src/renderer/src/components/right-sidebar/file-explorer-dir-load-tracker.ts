export type FileExplorerDirLoadToken = {
  dirPath: string
  revision: number
  session: number
}

export type FileExplorerDirLoadSession = number

export type FileExplorerDirLoadTracker = {
  begin: (dirPath: string) => FileExplorerDirLoadToken
  isCurrent: (token: FileExplorerDirLoadToken) => boolean
  getSession: () => FileExplorerDirLoadSession
  isSessionCurrent: (session: FileExplorerDirLoadSession) => boolean
  reset: () => void
}

export function createFileExplorerDirLoadTracker(): FileExplorerDirLoadTracker {
  let session = 0
  const revisionsByDir = new Map<string, number>()

  return {
    begin: (dirPath) => {
      const revision = (revisionsByDir.get(dirPath) ?? 0) + 1
      revisionsByDir.set(dirPath, revision)
      return { dirPath, revision, session }
    },
    isCurrent: (token) =>
      token.session === session && revisionsByDir.get(token.dirPath) === token.revision,
    getSession: () => session,
    isSessionCurrent: (snapshot) => snapshot === session,
    reset: () => {
      session += 1
      revisionsByDir.clear()
    }
  }
}
