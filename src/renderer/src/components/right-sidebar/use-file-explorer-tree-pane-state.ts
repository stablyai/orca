import type { Dispatch, RefObject, SetStateAction } from 'react'
import { useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useWorkspaceFileBrowserActionPredicate } from '@/lib/file-preview'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import type { OpenFile } from '@/store/slices/editor'
import type { Repo } from '../../../../shared/repo-types'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'
import type { TreeNode } from './file-explorer-types'
import { buildFolderStatusMap, buildStatusMap } from './status-display'
import { useFileDeletion } from './useFileDeletion'
import { useFileExplorerDragDrop } from './useFileExplorerDragDrop'
import { useFileExplorerHandlers } from './useFileExplorerHandlers'
import { useFileExplorerImport } from './useFileExplorerImport'
import { useFileExplorerInlineInput } from './useFileExplorerInlineInput'
import { useFileExplorerNodeCommands } from './use-file-explorer-node-commands'
import { useFileExplorerRowScrolling } from './use-file-explorer-row-scrolling'
import { useFileExplorerTreeLoadEffects } from './use-file-explorer-tree-load-effects'
import { useFileExplorerWatch } from './useFileExplorerWatch'
import type { useFileExplorerSelection } from './useFileExplorerSelection'
import type { useFileExplorerTree } from './useFileExplorerTree'

type UseFileExplorerTreePaneStateParams = {
  activeWorktreeId: string | null
  activeRepo: Repo | null
  worktreePath: string | null
  visibleFilesWorktreePath: string | null
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
}

type UseFileExplorerTreePaneStateResult = {
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
}

/**
 * Owns every effect and command handler behind the explorer tree pane.
 *
 * Why: this must be called by FileExplorer above its `!worktreePath` early
 * return. The reset guard and SSH generation refs live here, and losing them
 * for a single null-worktree render would re-reset the tree — dropping the
 * whole directory cache — when the same workspace comes back.
 */
export function useFileExplorerTreePaneState({
  activeWorktreeId,
  activeRepo,
  worktreePath,
  visibleFilesWorktreePath,
  expanded,
  activeFileId,
  openFiles,
  hasNameFilter,
  setNameFilterQuery,
  handleToggleNameFilterDir,
  tree,
  selection,
  selectedNode,
  rowProjection,
  rowExpandedPaths,
  visibleRowCount
}: UseFileExplorerTreePaneStateParams): UseFileExplorerTreePaneStateResult {
  const {
    dirCache,
    setDirCache,
    loadingDirPaths,
    rootCache,
    rootError,
    loadDir,
    statPath,
    markPathAsDirectory,
    refreshTree,
    refreshDir,
    isDirStale,
    resetAndLoad
  } = tree
  const {
    setSingleSelectedPath,
    setSelectedPaths,
    resetSelection,
    selectRowWithModifiers,
    moveSelection,
    selectedPaths
  } = selection

  const scrollRef = useRef<HTMLDivElement>(null)
  const canOpenWorkspaceFileBrowserForPath =
    useWorkspaceFileBrowserActionPredicate(activeWorktreeId)
  const supportsFolderDownload = useAppStore((s) => {
    const connectionId = activeRepo?.connectionId
    return connectionId
      ? s.sshConnectionStates.get(connectionId)?.supportsFolderDownload === true
      : false
  })
  const activeRuntimeEnvironmentId = useAppStore((s) =>
    getRuntimeEnvironmentIdForWorktree(s, activeWorktreeId)
  )
  const toggleDir = useAppStore((s) => s.toggleDir)
  const openFile = useAppStore((s) => s.openFile)
  const makePreviewFilePermanent = useAppStore((s) => s.makePreviewFilePermanent)
  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)
  const closeFile = useAppStore((s) => s.closeFile)

  const runtimeDownloadContext = useMemo(
    () =>
      activeRuntimeEnvironmentId && activeWorktreeId && worktreePath
        ? {
            settings: { activeRuntimeEnvironmentId },
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId: activeRepo?.connectionId ?? undefined
          }
        : null,
    [activeRepo?.connectionId, activeRuntimeEnvironmentId, activeWorktreeId, worktreePath]
  )
  const isWindows = useMemo(() => navigator.userAgent.includes('Windows'), [])

  const entries = useMemo(
    () => (activeWorktreeId ? (gitStatusByWorktree[activeWorktreeId] ?? []) : []),
    [activeWorktreeId, gitStatusByWorktree]
  )
  const statusByRelativePath = useMemo(() => buildStatusMap(entries), [entries])
  const folderStatusByRelativePath = useMemo(() => buildFolderStatusMap(entries), [entries])

  const deletion = useFileDeletion({
    activeWorktreeId,
    openFiles,
    closeFile,
    refreshDir,
    setSelectedPaths,
    isWindows
  })

  const dragDrop = useFileExplorerDragDrop({
    worktreePath,
    activeWorktreeId,
    expanded,
    toggleDir,
    refreshDir,
    scrollRef,
    getOperationOwnerForPath: (path) => rowProjection.getRowByPath(path)?.operationOwner
  })

  useFileExplorerTreeLoadEffects({
    visibleFilesWorktreePath,
    expanded,
    dirCache,
    loadingDirPaths,
    rootError,
    isDirStale,
    loadDir,
    resetAndLoad,
    resetSelection,
    setNameFilterQuery
  })

  const inlineInputState = useFileExplorerInlineInput({
    activeWorktreeId,
    worktreePath: visibleFilesWorktreePath,
    expanded,
    rowProjection,
    scrollRef,
    refreshDir
  })

  useFileExplorerWatch({
    worktreePath: visibleFilesWorktreePath,
    activeWorktreeId,
    dirCache,
    setDirCache,
    expanded,
    setSelectedPath: setSingleSelectedPath,
    refreshDir,
    refreshTree,
    inlineInput: inlineInputState.inlineInput,
    dragSourcePath: dragDrop.dragSourcePath,
    isNativeDragOver: dragDrop.isNativeDragOver,
    operationOwner: rootCache?.operationOwner
  })

  useFileExplorerImport({
    worktreePath: visibleFilesWorktreePath,
    activeWorktreeId,
    refreshDir,
    clearNativeDragState: dragDrop.clearNativeDragState,
    setSelectedPath: setSingleSelectedPath,
    operationOwner: rootCache?.operationOwner
  })

  const rowScrolling = useFileExplorerRowScrolling({
    visibleRowCount,
    inlineInputIndex: inlineInputState.inlineInputIndex,
    rowProjection,
    scrollRef,
    activeWorktreeId,
    worktreePath: visibleFilesWorktreePath,
    expanded,
    dirCache,
    loadingDirPaths,
    rootCache,
    loadDir,
    setSelectedPath: setSingleSelectedPath,
    activeFileId,
    openFiles
  })

  const handlers = useFileExplorerHandlers({
    activeWorktreeId,
    runtimeEnvironmentId: activeRuntimeEnvironmentId,
    openFile,
    makePreviewFilePermanent,
    toggleDir: hasNameFilter ? handleToggleNameFilterDir : toggleDir,
    loadDir,
    statPath,
    authorizeExternalPath: window.api.fs.authorizeExternalPath,
    markPathAsDirectory,
    setSelectedPath: setSingleSelectedPath,
    scrollRef
  })

  const nodeCommands = useFileExplorerNodeCommands({
    activeWorktreeId,
    worktreePath,
    activeRepo,
    containerRef: rowScrolling.explorerShellRef,
    rowProjection,
    rowExpandedPaths,
    selectedPaths,
    selectedNode,
    selectRowWithModifiers,
    moveSelection,
    inlineInput: inlineInputState.inlineInput,
    startRename: inlineInputState.startRename,
    requestDelete: deletion.requestDelete,
    requestDeleteAll: deletion.requestDeleteAll,
    refreshDir,
    handleClick: handlers.handleClick,
    cancelPendingDirToggle: handlers.cancelPendingDirToggle,
    toggleDir: hasNameFilter ? handleToggleNameFilterDir : toggleDir,
    scrollToIndex: rowScrolling.scrollToIndex
  })

  return {
    scrollRef,
    runtimeDownloadContext,
    supportsFolderDownload,
    canOpenWorkspaceFileBrowserForPath,
    statusByRelativePath,
    folderStatusByRelativePath,
    deletion,
    dragDrop,
    inlineInputState,
    rowScrolling,
    handlers,
    nodeCommands
  }
}
