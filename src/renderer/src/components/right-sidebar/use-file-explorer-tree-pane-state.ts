import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { useWorkspaceFileBrowserActionPredicate } from '@/lib/file-preview'
import type {
  UseFileExplorerTreePaneStateParams,
  UseFileExplorerTreePaneStateResult
} from './file-explorer-types'
import { buildFolderStatusMap, buildStatusMap } from './status-display'
import { useFileDeletion } from './useFileDeletion'
import { useFileExplorerDragDrop } from './useFileExplorerDragDrop'
import { useFileExplorerHandlers } from './useFileExplorerHandlers'
import { useFileExplorerImport } from './useFileExplorerImport'
import { useFileExplorerInlineInput } from './useFileExplorerInlineInput'
import { useFileExplorerNodeCommands } from './use-file-explorer-node-commands'
import { useFileExplorerRowScrolling } from './use-file-explorer-row-scrolling'
import { useFileExplorerLoadMore } from './use-file-explorer-load-more'
import { useFileExplorerTreeLoadEffects } from './use-file-explorer-tree-load-effects'
import { useFileExplorerWatch } from './useFileExplorerWatch'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'

/** Call above FileExplorer’s null-worktree return; losing reset/SSH refs for one render would discard the returning workspace’s directory cache. */
export function useFileExplorerTreePaneState({
  onRevealOutsideRoot,
  activeWorktreeId,
  activeRepo,
  worktreePath,
  visibleFilesWorktreePath,
  displayRootPath,
  effectiveExpanded,
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
  visibleRowCount,
  pathOwner
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
    loadMoreDir,
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

  const pendingReveal = useAppStore((s) => s.pendingExplorerReveal)
  useEffect(() => {
    if (pendingReveal?.worktreeId === activeWorktreeId && hasNameFilter) {
      setNameFilterQuery('')
    }
  }, [pendingReveal, activeWorktreeId, hasNameFilter, setNameFilterQuery])

  const scrollRef = useRef<HTMLDivElement>(null)
  const canOpenWorkspaceFileBrowserForPath =
    useWorkspaceFileBrowserActionPredicate(activeWorktreeId)
  const supportsFolderDownload = useAppStore((s) => {
    const connectionId = activeRepo?.connectionId
    return connectionId
      ? s.sshConnectionStates.get(connectionId)?.supportsFolderDownload === true
      : false
  })
  const ownerRuntimeEnvironmentId = useAppStore((s) =>
    runtimeEnvironmentIdOrLocalUnlessTwin(s, activeWorktreeId)
  )
  const { requestDir } = tree
  const storeToggleDir = useAppStore((s) => s.toggleDir)
  const toggleDir = useCallback(
    (id: string, path: string) => {
      const opening = !useAppStore.getState().expandedDirs[id]?.has(path)
      storeToggleDir(id, path)
      if (opening) {
        requestDir(path)
      }
    },
    [storeToggleDir, requestDir]
  )
  const openFile = useAppStore((s) => s.openFile)
  const makePreviewFilePermanent = useAppStore((s) => s.makePreviewFilePermanent)
  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)
  const closeFile = useAppStore((s) => s.closeFile)

  const runtimeDownloadContext = useMemo(
    () =>
      ownerRuntimeEnvironmentId && activeWorktreeId && worktreePath
        ? {
            target: runtimeTargetForOwnerEnvironment(ownerRuntimeEnvironmentId),
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId: activeRepo?.connectionId ?? undefined
          }
        : null,
    [activeRepo?.connectionId, ownerRuntimeEnvironmentId, activeWorktreeId, worktreePath]
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
    displayRootPath,
    activeWorktreeId,
    expanded,
    toggleDir,
    requestDir: tree.requestDir,
    refreshDir,
    scrollRef,
    getOperationOwnerForPath: (path) => rowProjection.getRowByPath(path)?.operationOwner
  })

  const inlineInputState = useFileExplorerInlineInput({
    activeWorktreeId,
    displayRootPath,
    worktreePath: visibleFilesWorktreePath,
    expanded,
    rowProjection,
    scrollRef,
    refreshDir,
    requestDir: tree.requestDir
  })

  useFileExplorerTreeLoadEffects({
    workspaceKey: activeWorktreeId,
    visibleFilesWorktreePath,
    activeWorktreeId,
    displayRootPath,
    expanded: effectiveExpanded,
    dirCache,
    loadingDirPaths,
    rootError:
      rootError ?? (displayRootPath ? tree.dirCache[displayRootPath]?.error : null) ?? null,
    invalidateTree: tree.invalidateTree,
    retireView: tree.retireView,
    reconcileView: tree.reconcileView,
    loadRevision: tree.loadRevision,
    interactionBlocked:
      inlineInputState.inlineInput !== null ||
      dragDrop.dragSourcePath !== null ||
      dragDrop.isNativeDragOver,
    resetAndLoad,
    resetSelection,
    setNameFilterQuery
  })

  useFileExplorerWatch({
    worktreePath: visibleFilesWorktreePath,
    activeWorktreeId,
    dirCache,
    setDirCache,
    expanded: effectiveExpanded,
    setSelectedPath: setSingleSelectedPath,
    refreshDir,
    refreshTree,
    inlineInput: inlineInputState.inlineInput,
    dragSourcePath: dragDrop.dragSourcePath,
    isNativeDragOver: dragDrop.isNativeDragOver,
    operationOwner: rootCache?.operationOwner
  })

  const fileDropOwnerRef = useFileExplorerImport({
    displayRootPath,
    worktreePath: visibleFilesWorktreePath,
    worktreeId: activeWorktreeId,
    refreshDir,
    clearNativeDragState: dragDrop.clearNativeDragState,
    setSelectedPath: setSingleSelectedPath,
    operationOwner: rootCache?.operationOwner
  })

  const rowScrolling = useFileExplorerRowScrolling({
    onRevealOutsideRoot,
    displayRootPath,
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
    loadMoreDir,
    observeDirForReveal: tree.observeDirForReveal,
    getRevealAuthority: tree.getRevealAuthority,
    loadRevision: tree.loadRevision,
    setSelectedPath: setSingleSelectedPath,
    activeFileId,
    openFiles
  })

  useFileExplorerLoadMore({
    virtualizer: rowScrolling.virtualizer,
    rowProjection,
    dirCache,
    loadingDirPaths,
    loadMoreDir
  })

  const handlers = useFileExplorerHandlers({
    activeWorktreeId,
    runtimeEnvironmentId: ownerRuntimeEnvironmentId,
    openFile,
    makePreviewFilePermanent,
    toggleDir: hasNameFilter ? handleToggleNameFilterDir : toggleDir,
    loadDir,
    statPath,
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
    toggleDir: hasNameFilter ? handleToggleNameFilterDir : toggleDir,
    scrollToIndex: rowScrolling.scrollToIndex,
    pathOwner
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
    nodeCommands,
    fileDropOwnerRef
  }
}
