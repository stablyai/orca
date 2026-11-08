import type { Dispatch, RefObject, SetStateAction } from 'react'
import { useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store/index'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { useWorkspaceFileBrowserActionPredicate } from '@/lib/file-preview'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { Repo } from '../../../../../../shared/repo-types'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'
import type { TreeNode } from './file-explorer-types'
import { buildFolderStatusMap, buildStatusMap } from '../../../../lib/git-path-decoration'
import { useFileDeletion } from '../mutations/useFileDeletion'
import { useFileExplorerDragDrop } from '../mutations/useFileExplorerDragDrop'
import { useFileExplorerHandlers } from '../mutations/useFileExplorerHandlers'
import { useFileExplorerImport } from '../mutations/useFileExplorerImport'
import { useFileExplorerInlineInput } from '../mutations/useFileExplorerInlineInput'
import { useFileExplorerNodeCommands } from '../mutations/use-file-explorer-node-commands'
import { useFileExplorerRowScrolling } from '../selection/use-file-explorer-row-scrolling'
import { useFileExplorerLoadMore } from './use-file-explorer-load-more'
import { useFileExplorerTreeLoadEffects } from './use-file-explorer-tree-load-effects'
import { useFileExplorerWatch } from '../watching/useFileExplorerWatch'
import type { useFileExplorerSelection } from '../selection/useFileExplorerSelection'
import type { useFileExplorerTree } from './useFileExplorerTree'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/rpc/targets/runtime-client-target'
import type { LocalPathOpenOwner } from '@/lib/local-path-open-guard'

// Why: a stable reference keeps the selector from re-rendering the pane when the active worktree has no status.
const NO_GIT_STATUS_ENTRIES: GitStatusEntry[] = []

type UseFileExplorerTreePaneStateParams = {
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
  fileDropOwnerRef: (root: HTMLElement | null) => void
}

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
  const toggleDir = useAppStore((s) => s.toggleDir)
  const openFile = useAppStore((s) => s.openFile)
  const makePreviewFilePermanent = useAppStore((s) => s.makePreviewFilePermanent)
  const entries = useAppStore((s) =>
    activeWorktreeId
      ? (s.gitStatusByWorktree[activeWorktreeId] ?? NO_GIT_STATUS_ENTRIES)
      : NO_GIT_STATUS_ENTRIES
  )
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
    refreshDir,
    scrollRef,
    getOperationOwnerForPath: (path) => rowProjection.getRowByPath(path)?.operationOwner
  })

  useFileExplorerTreeLoadEffects({
    workspaceKey: activeWorktreeId,
    visibleFilesWorktreePath,
    displayRootPath,
    expanded: effectiveExpanded,
    dirCache,
    loadingDirPaths,
    rootError:
      rootError ?? (displayRootPath ? tree.dirCache[displayRootPath]?.error : null) ?? null,
    isDirStale,
    loadDir,
    refreshTree,
    resetAndLoad,
    resetSelection,
    setNameFilterQuery
  })

  const inlineInputState = useFileExplorerInlineInput({
    activeWorktreeId,
    displayRootPath,
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
    loadDir,
    loadMoreDir,
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
