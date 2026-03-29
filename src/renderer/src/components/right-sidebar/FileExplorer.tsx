import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronRight, File, Folder, FolderOpen, Loader2 } from 'lucide-react'
import { useAppStore } from '@/store'
import { detectLanguage } from '@/lib/language-detect'
import { joinPath, normalizeRelativePath } from '@/lib/path'
import { cn } from '@/lib/utils'
import type { GitFileStatus } from '../../../../shared/types'
import { splitPathSegments } from './path-tree'
import {
  buildStatusMap,
  getDominantStatus,
  shouldPropagateStatus,
  STATUS_COLORS,
  STATUS_LABELS
} from './status-display'

type TreeNode = {
  name: string
  path: string // absolute path
  relativePath: string
  isDirectory: boolean
  depth: number
}

type DirCache = {
  children: TreeNode[]
  loading: boolean
}

export default function FileExplorer(): React.JSX.Element {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const expandedDirs = useAppStore((s) => s.expandedDirs)
  const toggleDir = useAppStore((s) => s.toggleDir)
  const openFile = useAppStore((s) => s.openFile)
  const pinFile = useAppStore((s) => s.pinFile)
  const activeFileId = useAppStore((s) => s.activeFileId)
  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)

  // Find active worktree path
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

  const [dirCache, setDirCache] = useState<Record<string, DirCache>>({})
  const scrollRef = useRef<HTMLDivElement>(null)

  const entries = useMemo(
    () => (activeWorktreeId ? (gitStatusByWorktree[activeWorktreeId] ?? []) : []),
    [activeWorktreeId, gitStatusByWorktree]
  )

  const statusByRelativePath = useMemo(() => buildStatusMap(entries), [entries])

  const folderStatusByRelativePath = useMemo(() => {
    const folderStatuses = new Map<string, GitFileStatus[]>()

    for (const entry of entries) {
      if (!shouldPropagateStatus(entry.status)) {
        continue
      }

      const segments = splitPathSegments(entry.path)
      if (segments.length <= 1) {
        continue
      }

      let currentPath = ''
      for (const segment of segments.slice(0, -1)) {
        currentPath = currentPath ? joinPath(currentPath, segment) : segment
        const statuses = folderStatuses.get(currentPath)
        if (statuses) {
          statuses.push(entry.status)
        } else {
          folderStatuses.set(currentPath, [entry.status])
        }
      }
    }

    return new Map(
      Array.from(folderStatuses.entries()).map(([folderPath, statuses]) => [
        folderPath,
        getDominantStatus(statuses)
      ])
    )
  }, [entries])

  const expanded = useMemo(
    () =>
      activeWorktreeId ? (expandedDirs[activeWorktreeId] ?? new Set<string>()) : new Set<string>(),
    [activeWorktreeId, expandedDirs]
  )

  // Load directory contents
  const loadDir = useCallback(
    async (dirPath: string, depth: number) => {
      if (dirCache[dirPath]?.children.length > 0 || dirCache[dirPath]?.loading) {
        return
      }

      setDirCache((prev) => ({
        ...prev,
        [dirPath]: { children: prev[dirPath]?.children ?? [], loading: true }
      }))

      try {
        const entries = (await window.api.fs.readDir({ dirPath })) as {
          name: string
          isDirectory: boolean
        }[]

        const children: TreeNode[] = entries
          .filter((e) => !e.name.startsWith('.') || e.name === '.github')
          .filter((e) => e.name !== 'node_modules' && e.name !== '.git')
          .map((e) => ({
            name: e.name,
            path: joinPath(dirPath, e.name),
            relativePath: worktreePath
              ? normalizeRelativePath(joinPath(dirPath, e.name).slice(worktreePath.length + 1))
              : e.name,
            isDirectory: e.isDirectory,
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
    [dirCache, worktreePath]
  )

  // Load root when worktree changes
  useEffect(() => {
    if (!worktreePath) {
      return
    }
    setDirCache({})
    void loadDir(worktreePath, -1)
  }, [worktreePath]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load expanded directories
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

  // Flatten tree into visible rows
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

  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 26,
    overscan: 20,
    getItemKey: (index) => flatRows[index].path
  })

  const handleClick = useCallback(
    (node: TreeNode) => {
      if (!activeWorktreeId) {
        return
      }

      if (node.isDirectory) {
        toggleDir(activeWorktreeId, node.path)
      } else {
        openFile({
          filePath: node.path,
          relativePath: node.relativePath,
          worktreeId: activeWorktreeId,
          language: detectLanguage(node.name),
          mode: 'edit'
        })
      }
    },
    [activeWorktreeId, toggleDir, openFile]
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

  if (!worktreePath) {
    return (
      <div className="flex items-center justify-center h-full text-[11px] text-muted-foreground px-4 text-center">
        Select a worktree to browse files
      </div>
    )
  }

  if (flatRows.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[11px] text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-auto scrollbar-sleek py-2">
      <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((vItem) => {
          const node = flatRows[vItem.index]
          const isExpanded = expanded.has(node.path)
          const isLoading = node.isDirectory && dirCache[node.path]?.loading
          const isActive = activeFileId === node.path
          const normalizedRelativePath = normalizeRelativePath(node.relativePath)
          const nodeStatus = node.isDirectory
            ? (folderStatusByRelativePath.get(normalizedRelativePath) ?? null)
            : (statusByRelativePath.get(normalizedRelativePath) ?? null)
          const statusColor = nodeStatus ? STATUS_COLORS[nodeStatus] : null

          return (
            <div
              key={vItem.key}
              data-index={vItem.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 right-0"
              style={{ transform: `translateY(${vItem.start}px)` }}
            >
              <button
                className={cn(
                  'flex items-center w-full py-1 px-2 gap-1 text-left text-xs transition-colors hover:bg-accent/60 rounded-sm',
                  isActive && !node.isDirectory && 'bg-accent text-accent-foreground'
                )}
                style={{ paddingLeft: `${node.depth * 16 + 8}px` }}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/x-orca-file-path', node.path)
                  e.dataTransfer.effectAllowed = 'copy'
                }}
                onClick={() => handleClick(node)}
                onDoubleClick={() => handleDoubleClick(node)}
              >
                {node.isDirectory ? (
                  <>
                    <ChevronRight
                      className={cn(
                        'size-3 shrink-0 text-muted-foreground transition-transform',
                        isExpanded && 'rotate-90'
                      )}
                    />
                    {isLoading ? (
                      <Loader2 className="size-3 shrink-0 text-muted-foreground animate-spin" />
                    ) : isExpanded ? (
                      <FolderOpen className="size-3 shrink-0 text-muted-foreground" />
                    ) : (
                      <Folder className="size-3 shrink-0 text-muted-foreground" />
                    )}
                  </>
                ) : (
                  <>
                    <span className="size-3 shrink-0" />
                    <File className="size-3 shrink-0 text-muted-foreground" />
                  </>
                )}
                <span
                  className={cn('truncate', isActive && !nodeStatus && 'text-accent-foreground')}
                  style={nodeStatus ? { color: statusColor ?? undefined } : undefined}
                >
                  {node.name}
                </span>
                {nodeStatus && (
                  <span
                    className="ml-auto shrink-0 text-[10px] font-semibold tracking-wide"
                    style={{ color: statusColor ?? undefined }}
                  >
                    {STATUS_LABELS[nodeStatus]}
                  </span>
                )}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
