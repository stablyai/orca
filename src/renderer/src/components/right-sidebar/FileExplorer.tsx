import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Loader2 } from 'lucide-react'
import { useAppStore } from '@/store'
import { dirname, normalizeRelativePath } from '@/lib/path'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { FileDeleteDialog } from './FileDeleteDialog'
import { FileExplorerBackgroundMenu } from './FileExplorerBackgroundMenu'
import { FileExplorerRow, InlineInputRow } from './FileExplorerRow'
import { splitPathSegments } from './path-tree'
import { buildFolderStatusMap, buildStatusMap, STATUS_COLORS } from './status-display'
import { useFileDeletion } from './useFileDeletion'
import { useFileExplorerAutoReveal } from './useFileExplorerAutoReveal'
import { useFileExplorerHandlers } from './useFileExplorerHandlers'
import { useFileExplorerReveal } from './useFileExplorerReveal'
import { useFileExplorerInlineInput } from './useFileExplorerInlineInput'
import { useFileExplorerKeys } from './useFileExplorerKeys'
import { useActiveWorktreePath } from './useActiveWorktreePath'
import { useFileDuplicate } from './useFileDuplicate'
import { useFileExplorerDragDrop } from './useFileExplorerDragDrop'
import { useFileExplorerTree } from './useFileExplorerTree'
import { useFileExplorerWatch } from './useFileExplorerWatch'

export default function FileExplorer(): React.JSX.Element {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const expandedDirs = useAppStore((s) => s.expandedDirs)
  const toggleDir = useAppStore((s) => s.toggleDir)
  const pendingExplorerReveal = useAppStore((s) => s.pendingExplorerReveal)
  const clearPendingExplorerReveal = useAppStore((s) => s.clearPendingExplorerReveal)
  const openFile = useAppStore((s) => s.openFile)
  const pinFile = useAppStore((s) => s.pinFile)
  const activeFileId = useAppStore((s) => s.activeFileId)
  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)
  const openFiles = useAppStore((s) => s.openFiles)
  const closeFile = useAppStore((s) => s.closeFile)

  const worktreePath = useActiveWorktreePath(activeWorktreeId, worktreesByRepo)

  const expanded = useMemo(
    () =>
      activeWorktreeId ? (expandedDirs[activeWorktreeId] ?? new Set<string>()) : new Set<string>(),
    [activeWorktreeId, expandedDirs]
  )

  const {
    dirCache,
    setDirCache,
    flatRows,
    rowsByPath,
    rootCache,
    rootError,
    loadDir,
    refreshTree,
    refreshDir,
    resetAndLoad
  } = useFileExplorerTree(worktreePath, expanded)

  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [flashingPath, setFlashingPath] = useState<string | null>(null)
  const [bgMenuOpen, setBgMenuOpen] = useState(false)
  const [bgMenuPoint, setBgMenuPoint] = useState({ x: 0, y: 0 })
  const scrollRef = useRef<HTMLDivElement>(null)
  const flashTimeoutRef = useRef<number | null>(null)
  const isMac = useMemo(() => navigator.userAgent.includes('Mac'), [])
  const isWindows = useMemo(() => navigator.userAgent.includes('Windows'), [])

  const clearFlashTimeout = useCallback(() => {
    if (flashTimeoutRef.current !== null) {
      window.clearTimeout(flashTimeoutRef.current)
      flashTimeoutRef.current = null
    }
  }, [])

  const entries = useMemo(
    () => (activeWorktreeId ? (gitStatusByWorktree[activeWorktreeId] ?? []) : []),
    [activeWorktreeId, gitStatusByWorktree]
  )
  const statusByRelativePath = useMemo(() => buildStatusMap(entries), [entries])
  const folderStatusByRelativePath = useMemo(() => buildFolderStatusMap(entries), [entries])

  const {
    pendingDelete,
    isDeleting,
    deleteShortcutLabel,
    deleteActionLabel,
    deleteDescription,
    requestDelete,
    closeDeleteDialog,
    confirmDelete
  } = useFileDeletion({
    activeWorktreeId,
    openFiles,
    closeFile,
    refreshDir,
    selectedPath,
    setSelectedPath,
    isMac,
    isWindows
  })

  const {
    handleMoveDrop,
    handleDragExpandDir,
    dropTargetDir,
    setDropTargetDir,
    dragSourcePath,
    setDragSourcePath,
    isRootDragOver,
    stopDragEdgeScroll,
    rootDragHandlers
  } = useFileExplorerDragDrop({
    worktreePath,
    activeWorktreeId,
    expanded,
    toggleDir,
    refreshDir,
    scrollRef
  })

  useEffect(() => {
    if (!worktreePath) {
      return
    }
    setSelectedPath(null)
    resetAndLoad()
  }, [worktreePath]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => clearFlashTimeout, [clearFlashTimeout])

  useEffect(() => {
    for (const dirPath of expanded) {
      if (!dirCache[dirPath]?.children.length && !dirCache[dirPath]?.loading) {
        const depth = worktreePath
          ? splitPathSegments(dirPath.slice(worktreePath.length + 1)).length - 1
          : 0
        void loadDir(dirPath, depth)
      }
    }
  }, [expanded]) // eslint-disable-line react-hooks/exhaustive-deps

  const {
    inlineInput,
    inlineInputIndex,
    startNew,
    startRename,
    dismissInlineInput,
    handleInlineSubmit
  } = useFileExplorerInlineInput({
    activeWorktreeId,
    worktreePath,
    expanded,
    flatRows,
    scrollRef,
    refreshDir
  })

  useFileExplorerWatch({
    worktreePath,
    activeWorktreeId,
    dirCache,
    setDirCache,
    expanded,
    setSelectedPath,
    refreshDir,
    refreshTree,
    inlineInput,
    dragSourcePath
  })

  const totalCount = flatRows.length + (inlineInputIndex >= 0 ? 1 : 0)

  const virtualizer = useVirtualizer({
    count: totalCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 26,
    overscan: 20,
    getItemKey: (index) => {
      if (inlineInputIndex >= 0) {
        if (index === inlineInputIndex) {
          return '__inline_input__'
        }
        const rowIndex = index > inlineInputIndex ? index - 1 : index
        return flatRows[rowIndex]?.path ?? `__fallback_${index}`
      }
      return flatRows[index]?.path ?? `__fallback_${index}`
    }
  })

  useFileExplorerReveal({
    activeWorktreeId,
    worktreePath,
    pendingExplorerReveal,
    clearPendingExplorerReveal,
    expanded,
    dirCache,
    rootCache,
    rowsByPath,
    flatRows,
    loadDir,
    setSelectedPath,
    setFlashingPath,
    flashTimeoutRef,
    virtualizer
  })

  useFileExplorerAutoReveal({
    activeFileId,
    activeWorktreeId,
    worktreePath,
    pendingExplorerReveal,
    openFiles,
    rowsByPath,
    flatRows,
    setSelectedPath,
    virtualizer
  })

  useEffect(() => {
    if (inlineInputIndex >= 0) {
      virtualizer.scrollToIndex(inlineInputIndex, { align: 'auto' })
    }
  }, [inlineInputIndex, virtualizer])

  const selectedNode = selectedPath ? (rowsByPath.get(selectedPath) ?? null) : null
  useFileExplorerKeys({
    containerRef: scrollRef,
    flatRows,
    inlineInput,
    selectedNode,
    startRename,
    requestDelete
  })

  const { handleClick, handleDoubleClick, handleWheelCapture } = useFileExplorerHandlers({
    activeWorktreeId,
    openFile,
    pinFile,
    toggleDir,
    setSelectedPath,
    scrollRef
  })

  const handleDuplicate = useFileDuplicate({ worktreePath, refreshDir })

  if (!worktreePath) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground px-4 text-center">
        Select a worktree to browse files
      </div>
    )
  }

  if (flatRows.length === 0 && !inlineInput) {
    if (rootCache?.loading ?? true) {
      return (
        <div className="flex items-center justify-center h-full text-[11px] text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
        </div>
      )
    }
    if (rootError) {
      return (
        <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
          Could not load files for this worktree: {rootError}
        </div>
      )
    }
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground px-4 text-center">
        No files in this worktree
      </div>
    )
  }

  return (
    <>
      <ScrollArea
        className={cn(
          'h-full min-h-0',
          isRootDragOver &&
            !(dragSourcePath && dirname(dragSourcePath) === worktreePath) &&
            'bg-border'
        )}
        viewportRef={scrollRef}
        viewportClassName="h-full min-h-0 py-2"
        onWheelCapture={handleWheelCapture}
        onDragOver={rootDragHandlers.onDragOver}
        onDragEnter={rootDragHandlers.onDragEnter}
        onDragLeave={rootDragHandlers.onDragLeave}
        onDrop={rootDragHandlers.onDrop}
        onDragEnd={() => {
          stopDragEdgeScroll()
          setDropTargetDir(null)
        }}
        onContextMenu={(e) => {
          const target = e.target as HTMLElement
          if (target.closest('[data-slot="context-menu-trigger"]')) {
            return
          }
          e.preventDefault()
          setBgMenuPoint({ x: e.clientX, y: e.clientY })
          setBgMenuOpen(true)
        }}
      >
        <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualizer.getVirtualItems().map((vItem) => {
            const isInlineRow = inlineInputIndex >= 0 && vItem.index === inlineInputIndex
            const rowIndex =
              !isInlineRow && inlineInputIndex >= 0 && vItem.index > inlineInputIndex
                ? vItem.index - 1
                : vItem.index
            const node = isInlineRow ? null : flatRows[rowIndex]
            if (!isInlineRow && !node) {
              return null
            }

            const showInline =
              isInlineRow ||
              (inlineInput?.type === 'rename' && node && inlineInput.existingPath === node.path)
            const inlineDepth = isInlineRow ? inlineInput!.depth : (node?.depth ?? 0)

            if (showInline) {
              return (
                <div
                  key={vItem.key}
                  data-index={vItem.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 right-0"
                  style={{ transform: `translateY(${vItem.start}px)` }}
                >
                  <InlineInputRow
                    depth={inlineDepth}
                    inlineInput={inlineInput!}
                    onSubmit={handleInlineSubmit}
                    onCancel={dismissInlineInput}
                  />
                </div>
              )
            }

            // Safe: the isInlineRow/showInline guards above ensure node is non-null here
            const n = node!
            const normalizedRelativePath = normalizeRelativePath(n.relativePath)
            const nodeStatus = n.isDirectory
              ? (folderStatusByRelativePath.get(normalizedRelativePath) ?? null)
              : (statusByRelativePath.get(normalizedRelativePath) ?? null)

            const rowParentDir = n.isDirectory ? n.path : dirname(n.path)
            const sourceParentDir = dragSourcePath ? dirname(dragSourcePath) : null
            const isInDropTarget =
              dropTargetDir != null &&
              dropTargetDir === rowParentDir &&
              dropTargetDir !== sourceParentDir
            return (
              <div
                key={vItem.key}
                data-index={vItem.index}
                ref={virtualizer.measureElement}
                className={cn('absolute left-0 right-0', isInDropTarget && 'bg-border')}
                style={{ transform: `translateY(${vItem.start}px)` }}
              >
                <FileExplorerRow
                  node={n}
                  isExpanded={expanded.has(n.path)}
                  isLoading={n.isDirectory && Boolean(dirCache[n.path]?.loading)}
                  isSelected={selectedPath === n.path || activeFileId === n.path}
                  isFlashing={flashingPath === n.path}
                  nodeStatus={nodeStatus}
                  statusColor={nodeStatus ? STATUS_COLORS[nodeStatus] : null}
                  deleteShortcutLabel={deleteShortcutLabel}
                  targetDir={n.isDirectory ? n.path : dirname(n.path)}
                  targetDepth={n.isDirectory ? n.depth + 1 : n.depth}
                  onClick={() => handleClick(n)}
                  onDoubleClick={() => handleDoubleClick(n)}
                  onSelect={() => setSelectedPath(n.path)}
                  onStartNew={startNew}
                  onStartRename={startRename}
                  onDuplicate={handleDuplicate}
                  onRequestDelete={() => requestDelete(n)}
                  onMoveDrop={handleMoveDrop}
                  onDragTargetChange={setDropTargetDir}
                  onDragSourceChange={setDragSourcePath}
                  onDragExpandDir={handleDragExpandDir}
                />
              </div>
            )
          })}
        </div>
      </ScrollArea>

      <FileExplorerBackgroundMenu
        open={bgMenuOpen}
        onOpenChange={setBgMenuOpen}
        point={bgMenuPoint}
        worktreePath={worktreePath}
        onStartNew={startNew}
      />

      <FileDeleteDialog
        pendingDelete={pendingDelete}
        isDeleting={isDeleting}
        deleteDescription={deleteDescription}
        deleteActionLabel={deleteActionLabel}
        onClose={closeDeleteDialog}
        onConfirm={() => void confirmDelete()}
      />
    </>
  )
}
