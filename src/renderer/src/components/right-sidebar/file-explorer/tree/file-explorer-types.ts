import type {
  FileExplorerDirCacheSetter,
  FileExplorerDirectoryCache
} from './file-explorer-directory-cache'
import type { UserOpenedPathStat } from '@/lib/files/access/user-opened-local-path'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { DirEntryCursor } from '../../../../../../shared/file-listing/file-dir-page'

export type FileExplorerOperationOwner =
  | { kind: 'local' }
  | { kind: 'ssh'; connectionId: string }
  | { kind: 'runtime'; environmentId: string; executionHostId: ExecutionHostId }
  | { kind: 'unresolved' }

export type TreeNode = {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
  isSymlink?: boolean
  /** Inferred from an opened link, not the parent's latest host listing. */
  isDirectoryFromOpenedLink?: boolean
  depth: number
  /** Listed through a folder link that leads out of the project, so it opens by absolute path. */
  outsideProject?: true
  /** Host snapshot that produced this node. Destructive actions fail closed without it. */
  operationOwner?: FileExplorerOperationOwner
}

/** Keep loading outside dirCache to avoid rebuilding the tree; see file-explorer-dir-load-state.ts. */
/** The host's last listed entry of a partly listed folder; the next page starts after it. */
export type FileExplorerDirMore = { after: DirEntryCursor }

export type DirCache = {
  repositoryMarker?: boolean
  error?: string
  children: TreeNode[]
  operationOwner?: FileExplorerOperationOwner
  /** Present while the host holds entries not yet listed here. */
  more?: FileExplorerDirMore
  /** Listed in pages because it is too big for one remote reply; a refresh pages straight away. */
  paged?: true
  /** Listed through a project folder link that leads out of the project. */
  outsideProject?: true
}

/** Retry covered dir reads after supersession, but not unreadable roots, which would add one dead transport timeout per dir. */
export type FileExplorerTreeRefreshOutcome = 'refreshed' | 'superseded' | 'root-unreadable'

export type UseFileExplorerTreeResult = {
  dirCache: Record<string, DirCache>
  dirCacheStore: FileExplorerDirectoryCache
  setDirCache: FileExplorerDirCacheSetter
  /** Workspace whose committed root listing owns the rendered cache. */
  sourceWorkspaceId: string | null
  /** Dirs with a read in flight — kept out of dirCache so the row projection does not rebuild. */
  loadingDirPaths: ReadonlySet<string>
  rootCache: DirCache | undefined
  rootError: string | null
  loadDir: (
    dirPath: string,
    depth: number,
    options?: { force?: boolean; failOnError?: boolean; wakeWslDistro?: boolean }
  ) => Promise<boolean>
  statPath: (path: string) => Promise<UserOpenedPathStat>
  markPathAsDirectory: (path: string) => void
  refreshTree: () => Promise<FileExplorerTreeRefreshOutcome>
  /** `wakeWslDistro` only for a user act: it may start a stopped WSL distro. */
  refreshDir: (dirPath: string, options?: { wakeWslDistro?: boolean }) => Promise<void>
  /** Reads the next page of a folder a remote server listed only in part. */
  loadMoreDir: (dirPath: string) => Promise<void>
  /** True while a dir's cached listing predates the last full refresh that skipped it. */
  isDirStale: (dirPath: string) => boolean
  resetAndLoad: (options?: { wakeWslDistro?: boolean }) => void
}
