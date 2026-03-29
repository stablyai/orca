import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Loader2 } from 'lucide-react'
import { useAppStore } from '@/store'
import { detectLanguage } from '@/lib/language-detect'
import { joinPath, normalizeRelativePath } from '@/lib/path'
import { ScrollArea } from '@/components/ui/scroll-area'
import { FileDeleteDialog } from './FileDeleteDialog'
import { FileExplorerRow } from './FileExplorerRow'
import type { DirCache, TreeNode } from './file-explorer-types'
import { splitPathSegments } from './path-tree'
import { shouldIncludeFileExplorerEntry } from './file-explorer-entries'
import { buildFolderStatusMap, buildStatusMap, STATUS_COLORS } from './status-display'
import { useFileDeletion } from './useFileDeletion'
import { useFileExplorerReveal } from './useFileExplorerReveal'

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
      const worktree = worktrees.find((candidate) => candidate.id === activeWorktreeId)
      if (worktree) {
        return worktree.path
      }
    }

    return null
  }, [activeWorktreeId, worktreesByRepo])

  const [dirCache, setDirCache] = useState<Record<string, DirCache>>({})
  const dirCacheRef = useRef(dirCache)
  dirCacheRef.current = dirCache
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [flashingPath, setFlashingPath] = useState<string | null>(null)
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

  const expanded = useMemo(
    () =>
      activeWorktreeId ? (expandedDirs[activeWorktreeId] ?? new Set<string>()) : new Set<string>(),
    [activeWorktreeId, expandedDirs]
  )

  const loadDir = useCallback(
    async (dirPath: string, depth: number, options?: { force?: boolean }) => {
      const cache = dirCacheRef.current
      if (!options?.force && (cache[dirPath]?.children.length > 0 || cache[dirPath]?.loading)) {
        return
      }

      setDirCache((prev) => ({
        ...prev,
        [dirPath]: {
          children: options?.force ? [] : (prev[dirPath]?.children ?? []),
          loading: true
        }
      }))

      try {
        const entries = await window.api.fs.readDir({ dirPath })
        const children: TreeNode[] = entries
          .filter(shouldIncludeFileExplorerEntry)
          .map((entry) => ({
            name: entry.name,
            path: joinPath(dirPath, entry.name),
            relativePath: worktreePath
              ? normalizeRelativePath(joinPath(dirPath, entry.name).slice(worktreePath.length + 1))
              : entry.name,
            isDirectory: entry.isDirectory,
            depth: depth + 1
          }))

        setDirCache((prev) => ({
          ...prev,
          [dirPath]: { children, loading: false }
        }))
      } catch {
        setDirCache((prev) => ({
          ...prev,
          [dirPath]: { children: [], loading: false }
        }))
      }
    },
    [worktreePath]
  )

  const refreshTree = useCallback(async () => {
    if (!worktreePath) {
      return
    }

    setDirCache({})
    await loadDir(worktreePath, -1, { force: true })

    await Promise.all(
      Array.from(expanded).map(async (dirPath) => {
        const depth = splitPathSegments(dirPath.slice(worktreePath.length + 1)).length - 1
        await loadDir(dirPath, depth, { force: true })
      })
    )
  }, [expanded, loadDir, worktreePath])

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
    setDirCache({})
    void loadDir(worktreePath, -1)
  }, [worktreePath]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return clearFlashTimeout
  }, [clearFlashTimeout])

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

  const flatRows = useMemo(() => {
    if (!worktreePath) {
      return []
    }

    const result: TreeNode[] = []

    const addChildren = (parentPath: string): void => {
      const cached = dirCache[parentPath]
      if (!cached?.children) {
        return
      }

      for (const child of cached.children) {
        result.push(child)
        if (child.isDirectory && expanded.has(child.path)) {
          addChildren(child.path)
        }
      }
    }

    addChildren(worktreePath)
    return result
  }, [worktreePath, dirCache, expanded])

  const rowsByPath = useMemo(() => new Map(flatRows.map((row) => [row.path, row])), [flatRows])
  const rootCache = worktreePath ? dirCache[worktreePath] : undefined

  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 26,
    overscan: 20,
    getItemKey: (index) => flatRows[index].path
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

  const handleExplorerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target
      if (
        !(target instanceof HTMLElement) ||
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable
      ) {
        return
      }

      const selectedNode =
        (selectedPath ? rowsByPath.get(selectedPath) : undefined) ??
        (activeFileId ? rowsByPath.get(activeFileId) : undefined)
      if (!selectedNode) {
        return
      }

      const isDeleteShortcut =
        event.key === 'Delete' || (isMac && event.key === 'Backspace' && event.metaKey)

      if (!isDeleteShortcut) {
        return
      }

      event.preventDefault()
      requestDelete(selectedNode)
    },
    [activeFileId, isMac, requestDelete, rowsByPath, selectedPath]
  )

  if (!worktreePath) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground px-4 text-center">
        Select a worktree to browse files
      </div>
    )
  }

  if (flatRows.length === 0) {
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
        onKeyDownCapture={handleExplorerKeyDown}
      >
        <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const node = flatRows[virtualItem.index]
            const normalizedRelativePath = normalizeRelativePath(node.relativePath)
            const nodeStatus = node.isDirectory
              ? (folderStatusByRelativePath.get(normalizedRelativePath) ?? null)
              : (statusByRelativePath.get(normalizedRelativePath) ?? null)

            return (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 right-0"
                style={{ transform: `translateY(${virtualItem.start}px)` }}
              >
                <FileExplorerRow
                  node={node}
                  isExpanded={expanded.has(node.path)}
                  isLoading={node.isDirectory && Boolean(dirCache[node.path]?.loading)}
                  isSelected={selectedPath === node.path || activeFileId === node.path}
                  isFlashing={flashingPath === node.path}
                  nodeStatus={nodeStatus}
                  statusColor={nodeStatus ? STATUS_COLORS[nodeStatus] : null}
                  deleteShortcutLabel={deleteShortcutLabel}
                  onClick={() => handleClick(node)}
                  onDoubleClick={() => handleDoubleClick(node)}
                  onSelect={() => setSelectedPath(node.path)}
                  onRequestDelete={() => requestDelete(node)}
                />
              </div>
            )
          })}
        </div>
      </ScrollArea>

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
