import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { FilePlus, FolderPlus, Loader2 } from 'lucide-react'
import { useAppStore } from '@/store'
import { detectLanguage } from '@/lib/language-detect'
import { dirname, normalizeRelativePath } from '@/lib/path'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { FileDeleteDialog } from './FileDeleteDialog'
import { FileExplorerRow, InlineInputRow } from './FileExplorerRow'
import type { TreeNode } from './file-explorer-types'
import { splitPathSegments } from './path-tree'
import { buildFolderStatusMap, buildStatusMap, STATUS_COLORS } from './status-display'
import { useFileDeletion } from './useFileDeletion'
import { useFileExplorerReveal } from './useFileExplorerReveal'
import { useFileExplorerInlineInput } from './useFileExplorerInlineInput'
import { useFileExplorerKeys } from './useFileExplorerKeys'
import { useFileExplorerTree } from './useFileExplorerTree'

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

  const worktreePath = useMemo(() => {
    if (!activeWorktreeId) {
      return null
    }
    for (const worktrees of Object.values(worktreesByRepo)) {
      const wt = worktrees.find((w) => w.id === activeWorktreeId)
      if (wt) {
        return wt.path
      }
    }
    return null
  }, [activeWorktreeId, worktreesByRepo])

  const expanded = useMemo(
    () =>
      activeWorktreeId ? (expandedDirs[activeWorktreeId] ?? new Set<string>()) : new Set<string>(),
    [activeWorktreeId, expandedDirs]
  )

  const {
    dirCache,
    flatRows,
    rowsByPath,
    rootCache,
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
    refreshTree,
    selectedPath,
    setSelectedPath,
    isMac,
    isWindows
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

  // Scroll the inline input into view so the virtualizer renders it.
  // Without this, an input created at the end of a long tree (e.g. from
  // the background context menu) can fall outside the visible + overscan
  // range and never appear.
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

  const handleClick = useCallback(
    (node: TreeNode) => {
      if (!activeWorktreeId) {
        return
      }
      setSelectedPath(node.path)
      if (node.isDirectory) {
        toggleDir(activeWorktreeId, node.path)
        return
      }
      openFile({
        filePath: node.path,
        relativePath: node.relativePath,
        worktreeId: activeWorktreeId,
        language: detectLanguage(node.name),
        mode: 'edit'
      })
    },
    [activeWorktreeId, openFile, toggleDir]
  )

  const handleDoubleClick = useCallback(
    (node: TreeNode) => {
      if (!activeWorktreeId || node.isDirectory) {
        return
      }
      pinFile(node.path)
    },
    [activeWorktreeId, pinFile]
  )

  const handleWheelCapture = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const container = scrollRef.current
    if (!container || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) {
      return
    }
    const target = e.target
    if (!(target instanceof Element) || !target.closest('[data-explorer-draggable="true"]')) {
      return
    }
    if (container.scrollHeight <= container.clientHeight) {
      return
    }
    e.preventDefault()
    container.scrollTop += e.deltaY
  }, [])

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
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground px-4 text-center">
        No files in this worktree
      </div>
    )
  }

  return (
    <>
      <ScrollArea
        className="h-full min-h-0"
        viewportRef={scrollRef}
        viewportClassName="h-full min-h-0 py-2"
        onWheelCapture={handleWheelCapture}
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

            return (
              <div
                key={vItem.key}
                data-index={vItem.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 right-0"
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
                  onRequestDelete={() => requestDelete(n)}
                />
              </div>
            )
          })}
        </div>
      </ScrollArea>

      <DropdownMenu open={bgMenuOpen} onOpenChange={setBgMenuOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none fixed size-px opacity-0"
            style={{ left: bgMenuPoint.x, top: bgMenuPoint.y }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-48"
          sideOffset={0}
          align="start"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <DropdownMenuItem onSelect={() => startNew('file', worktreePath, 0)}>
            <FilePlus />
            New File
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => startNew('folder', worktreePath, 0)}>
            <FolderPlus />
            New Folder
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

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
