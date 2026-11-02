import type { Virtualizer } from '@tanstack/react-virtual'
import type { useWorkspaceFileBrowserActionPredicate } from '@/lib/file-preview'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import type { OpenFile } from '@/store/slices/editor'
import type { LocalPathOpenOwner } from '@/lib/local-path-open-guard'
import type { Repo } from '../../../../shared/repo-types'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'
import type { buildFolderStatusMap, buildStatusMap } from './status-display'
import type { useFileDeletion } from './useFileDeletion'
import type { useFileExplorerDragDrop } from './useFileExplorerDragDrop'
import type { useFileExplorerHandlers } from './useFileExplorerHandlers'
import type { useFileExplorerInlineInput } from './useFileExplorerInlineInput'
import type { useFileExplorerNodeCommands } from './use-file-explorer-node-commands'
import type { useFileExplorerRowScrolling } from './use-file-explorer-row-scrolling'
import type { useFileExplorerSelection } from './useFileExplorerSelection'
import type { useFileExplorerTree } from './useFileExplorerTree'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { UserOpenedPathStat } from '@/lib/user-opened-local-path'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { DirEntryCursor } from '../../../../shared/file-dir-page'

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

export type FileExplorerDirectoryReadOptions = {
  force?: boolean
  failOnError?: boolean
  wakeWslDistro?: boolean
}

export type FileExplorerRevealOrigin = 'manual' | 'active-file'
export type FileExplorerRevealObservation = (
  path: string,
  depth: number,
  origin: FileExplorerRevealOrigin,
  isCurrent: () => boolean
) => Promise<FileExplorerTreeRefreshOutcome>

export type FileExplorerRevealAuthority = (
  paths: readonly string[],
  renderedCache: Readonly<Record<string, DirCache>>
) => 'pending' | 'terminal' | 'ready'

export type UseFileExplorerTreeResult = {
  getRevealAuthority: FileExplorerRevealAuthority
  observeDirForReveal: FileExplorerRevealObservation
  dirCache: Record<string, DirCache>
  setDirCache: Dispatch<SetStateAction<Record<string, DirCache>>>
  /** Workspace whose committed root listing owns the rendered cache. */
  sourceWorkspaceId: string | null
  /** Dirs with a read in flight — kept out of dirCache so the row projection does not rebuild. */
  loadingDirPaths: ReadonlySet<string>
  rootCache: DirCache | undefined
  rootError: string | null
  loadDir: (
    dirPath: string,
    depth: number,
    options?: FileExplorerDirectoryReadOptions
  ) => Promise<boolean>
  statPath: (path: string) => Promise<UserOpenedPathStat>
  markPathAsDirectory: (path: string) => void
  refreshTree: () => Promise<FileExplorerTreeRefreshOutcome>
  /** `wakeWslDistro` only for a user act: it may start a stopped WSL distro. */
  refreshDir: (dirPath: string, options?: { wakeWslDistro?: boolean }) => Promise<void>
  /** Reads the next page of a partly listed remote folder. */
  loadMoreDir: (dirPath: string) => Promise<void>
  /** True while a cached listing still needs verification after invalidation. */
  isDirStale: (dirPath: string) => boolean
  invalidateTree: () => void
  retireView: () => void
  requestDir: (dirPath: string) => void
  reconcileView: (
    requiredDirs: Set<string>,
    canCommit: () => boolean,
    viewError: string | null,
    displayRootPath?: string | null
  ) => void
  loadRevision: number
  resetAndLoad: (options?: { wakeWslDistro?: boolean }) => void
}

export type UseFileExplorerTreePaneStateParams = {
  onRevealOutsideRoot?: () => void
  activeWorktreeId: string | null
  activeRepo: Repo | null
  worktreePath: string | null
  visibleFilesWorktreePath: string | null
  displayRootPath: string | null
  effectiveExpanded: Set<string>
  expanded: Set<string>
  activeFileId: string | null
  openFiles: OpenFile[]
  hasNameFilter: boolean
  setNameFilterQuery: Dispatch<SetStateAction<string>>
  handleToggleNameFilterDir: (worktreeId: string, dirPath: string) => void
  tree: ReturnType<typeof useFileExplorerTree>
  selection: ReturnType<typeof useFileExplorerSelection>
  selectedNode: TreeNode | null
  rowProjection: FileExplorerRowProjection
  rowExpandedPaths: Set<string>
  visibleRowCount: number
  pathOwner: LocalPathOpenOwner
}

export type UseFileExplorerTreePaneStateResult = {
  scrollRef: RefObject<HTMLDivElement | null>
  runtimeDownloadContext: RuntimeFileOperationArgs | null
  supportsFolderDownload: boolean
  canOpenWorkspaceFileBrowserForPath: ReturnType<typeof useWorkspaceFileBrowserActionPredicate>
  statusByRelativePath: ReturnType<typeof buildStatusMap>
  folderStatusByRelativePath: ReturnType<typeof buildFolderStatusMap>
  deletion: ReturnType<typeof useFileDeletion>
  dragDrop: ReturnType<typeof useFileExplorerDragDrop>
  inlineInputState: ReturnType<typeof useFileExplorerInlineInput>
  rowScrolling: ReturnType<typeof useFileExplorerRowScrolling>
  handlers: ReturnType<typeof useFileExplorerHandlers>
  nodeCommands: ReturnType<typeof useFileExplorerNodeCommands>
  fileDropOwnerRef: (root: HTMLElement | null) => void
}

export type UseFileExplorerRevealParams = {
  onRevealOutsideRoot?: () => void
  activeWorktreeId: string | null
  worktreePath: string | null
  displayRootPath?: string | null
  pendingExplorerReveal: {
    worktreeId: string
    filePath: string
    origin: FileExplorerRevealOrigin
    requestId: number
    flash?: boolean
  } | null
  clearPendingExplorerReveal: () => void
  expanded: Set<string>
  dirCache: Record<string, DirCache>
  loadingDirPaths: ReadonlySet<string>
  rootCache: DirCache | undefined
  rowProjection: FileExplorerRowProjection
  getRevealAuthority: FileExplorerRevealAuthority
  loadRevision: number
  observeDirForReveal: FileExplorerRevealObservation
  loadMoreDir?: (dirPath: string) => Promise<void>
  setSelectedPath: (path: string | null) => void
  setFlashingPath: Dispatch<SetStateAction<string | null>>
  flashTimeoutRef: RefObject<number | null>
  virtualizer: Virtualizer<HTMLDivElement, Element>
}
