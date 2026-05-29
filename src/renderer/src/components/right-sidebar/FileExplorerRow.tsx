/* eslint-disable max-lines -- File Explorer rows own dense context-menu and drag/drop interactions. */
import React, { useCallback, useEffect, useRef } from 'react'
import { basename } from '@/lib/path'
import {
  ChevronRight,
  CircleSlash,
  Copy,
  ExternalLink,
  Eye,
  File,
  FilePlus,
  Files,
  Folder,
  FolderPlus,
  Globe,
  ListCollapse,
  Link,
  Loader2,
  Pencil,
  Search,
  Trash2
} from 'lucide-react'
import { toast } from 'sonner'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { detectLanguage } from '@/lib/language-detect'
import { useFileIcon } from '@/hooks/useFileIcon'
import { openFileInBrowserTab } from '@/lib/file-preview'
import {
  encodeWorkspaceFilePaths,
  WORKSPACE_FILE_PATH_MIME,
  WORKSPACE_FILE_PATHS_MIME
} from '@/lib/workspace-file-drag'
import type { GitFileStatus } from '../../../../shared/types'
import { STATUS_LABELS } from './status-display'
import type { TreeNode } from './file-explorer-types'
import { useFileExplorerRowDrag } from './useFileExplorerRowDrag'
import { isLocalPathOpenBlocked, showLocalPathOpenBlockedToast } from '@/lib/local-path-open-guard'

const ICON_STYLE: React.CSSProperties = {
  width: 'var(--fe-icon-size)',
  height: 'var(--fe-icon-size)'
}

const isMac = navigator.userAgent.includes('Mac')
const isLinux = navigator.userAgent.includes('Linux')

/** Platform-appropriate label: macOS → Finder, Windows → File Explorer, Linux → Files */
const revealLabel = isMac
  ? 'Reveal in Finder'
  : isLinux
    ? 'Open Containing Folder'
    : 'Reveal in File Explorer'

function stopRightButtonMenuSelection(event: React.PointerEvent): void {
  if (event.button !== 2) {
    return
  }
  // Why: Radix opens context menus under the pointer; on some macOS/Electron
  // paths the right-button release lands on the first item and selects it.
  event.preventDefault()
  event.stopPropagation()
}

export type InlineInput = {
  parentPath: string
  type: 'file' | 'folder' | 'rename'
  depth: number
  existingName?: string
  existingPath?: string
}

// ─── Inline Input Row ────────────────────────────────────────────

export function InlineInputRow({
  depth,
  inlineInput,
  onSubmit,
  onCancel
}: {
  depth: number
  inlineInput: InlineInput
  onSubmit: (value: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const blurTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const submitted = useRef(false)
  // Grace period flag: when a menu (context or dropdown) closes, its focus
  // management can momentarily steal focus from this input before the user
  // has a chance to type. During the grace window we re-focus on blur instead
  // of auto-submitting, which would dismiss the empty input.
  const focusSettled = useRef(false)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    submitted.current = false
    focusSettled.current = false

    // Schedule focus after any pending focus-restore from menu close
    const raf = requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) {
        return
      }
      el.focus()
      if (inlineInput.type === 'rename' && inlineInput.existingName) {
        const dotIndex = inlineInput.existingName.lastIndexOf('.')
        if (dotIndex > 0) {
          el.setSelectionRange(0, dotIndex)
        } else {
          el.select()
        }
      }
      // Allow enough time for the menu close focus management to finish
      // before treating blur events as intentional user actions.
      settleTimer.current = setTimeout(() => {
        settleTimer.current = null
        focusSettled.current = true
      }, 200)
    })
    return () => {
      cancelAnimationFrame(raf)
      if (blurTimeout.current) {
        clearTimeout(blurTimeout.current)
      }
      if (settleTimer.current) {
        clearTimeout(settleTimer.current)
      }
    }
  }, [inlineInput])

  const clearBlurTimeout = useCallback(() => {
    if (blurTimeout.current) {
      clearTimeout(blurTimeout.current)
      blurTimeout.current = null
    }
  }, [])

  const submit = useCallback(
    (value: string) => {
      if (submitted.current) {
        return
      }
      submitted.current = true
      clearBlurTimeout()
      onSubmit(value)
    },
    [onSubmit, clearBlurTimeout]
  )

  return (
    <div
      className="flex items-center w-full h-[26px] px-2 gap-1"
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
    >
      <span className="shrink-0" style={ICON_STYLE} />
      {inlineInput.type === 'folder' ? (
        <Folder className="shrink-0 text-muted-foreground" style={ICON_STYLE} />
      ) : (
        <File className="shrink-0 text-muted-foreground" style={ICON_STYLE} />
      )}
      <input
        ref={inputRef}
        className="flex-1 min-w-0 bg-transparent text-[length:var(--fe-text-size,12px)] text-foreground outline-none border border-ring rounded-sm px-1"
        defaultValue={inlineInput.type === 'rename' ? inlineInput.existingName : ''}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit(e.currentTarget.value)
          } else if (e.key === 'Escape') {
            clearBlurTimeout()
            submitted.current = true
            onCancel()
          }
        }}
        onFocus={clearBlurTimeout}
        onBlur={(e) => {
          // When a Radix menu (context or dropdown) closes, it restores focus
          // to its trigger button, which steals focus from this input before
          // the user can type. Detect this by checking relatedTarget — if focus
          // moved to any menu trigger, it's Radix cleanup, not a user action.
          if (
            e.relatedTarget instanceof HTMLElement &&
            (e.relatedTarget.closest('[data-slot="context-menu-trigger"]') ||
              e.relatedTarget.closest('[data-slot="dropdown-menu-trigger"]'))
          ) {
            requestAnimationFrame(() => inputRef.current?.focus())
            return
          }
          // During the grace period after mount, menu close focus management
          // may shift focus away (often relatedTarget is null). Re-focus
          // instead of dismissing the still-empty input.
          if (!focusSettled.current) {
            requestAnimationFrame(() => inputRef.current?.focus())
            return
          }
          const value = e.currentTarget.value
          blurTimeout.current = setTimeout(() => {
            blurTimeout.current = null
            submit(value)
          }, 150)
        }}
      />
    </div>
  )
}

// ─── File / Folder Row with Context Menu ─────────────────────────

type FileExplorerRowProps = {
  node: TreeNode
  isExpanded: boolean
  isLoading: boolean
  isSelected: boolean
  isFlashing: boolean
  selectedPaths: Set<string>
  nodeStatus: GitFileStatus | null
  statusColor: string | null
  isIgnored: boolean
  deleteShortcutLabel: string
  targetDir: string
  targetDepth: number
  selectionSize: number
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  onDoubleClick: () => void
  onContextMenuSelect: () => void
  onCopyPaths: (pathKind: 'absolute' | 'relative') => void
  onStartNew: (type: 'file' | 'folder', dir: string, depth: number) => void
  onStartRename: (node: TreeNode) => void
  onDuplicate: (node: TreeNode) => void
  onRequestDelete: () => void
  onCollapseFolderSubtree: () => void
  onFindInFolder: () => void
  onMoveDrop: (sourcePath: string, destDir: string) => void
  onDragTargetChange: (dir: string | null) => void
  onDragSourceChange: (path: string | null) => void
  onDragExpandDir: (dirPath: string) => void
  onNativeDragTargetChange: (dir: string | null) => void
  onNativeDragExpandDir: (dirPath: string) => void
}

export function shouldShowCollapseFolderAction(node: TreeNode, isExpanded: boolean): boolean {
  return node.isDirectory && isExpanded
}

export function shouldShowFindInFolderAction(node: TreeNode): boolean {
  return node.isDirectory
}

export function FileExplorerRow({
  node,
  isExpanded,
  isLoading,
  isSelected,
  isFlashing,
  selectedPaths,
  nodeStatus,
  statusColor,
  isIgnored,
  deleteShortcutLabel,
  targetDir,
  targetDepth,
  selectionSize,
  onClick,
  onDoubleClick,
  onContextMenuSelect,
  onCopyPaths,
  onStartNew,
  onStartRename,
  onDuplicate,
  onRequestDelete,
  onCollapseFolderSubtree,
  onFindInFolder,
  onMoveDrop,
  onDragTargetChange,
  onDragSourceChange,
  onDragExpandDir,
  onNativeDragTargetChange,
  onNativeDragExpandDir
}: FileExplorerRowProps): React.JSX.Element {
  const openMarkdownPreview = useAppStore((s) => s.openMarkdownPreview)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const { Icon: ResolvedIcon, monochrome: iconThemeMonochrome } = useFileIcon(
    node.relativePath || node.name,
    node.isDirectory,
    isExpanded
  )
  const copyPathShortcutLabel = useShortcutLabel('fileExplorer.copyPath')
  const copyRelativePathShortcutLabel = useShortcutLabel('fileExplorer.copyRelativePath')
  const findInFolderShortcutLabel = useShortcutLabel('sidebar.search.toggle')
  const rowDropDir = node.isDirectory ? node.path : targetDir
  const { handleDragOver, handleDragEnter, handleDragLeave, handleDrop } = useFileExplorerRowDrag({
    rowDropDir,
    isDirectory: node.isDirectory,
    nodePath: node.path,
    isExpanded,
    onDragTargetChange,
    onDragExpandDir,
    onNativeDragTargetChange,
    onNativeDragExpandDir,
    onMoveDrop
  })
  const handleOpenInOrcaBrowser = useCallback(() => {
    if (!activeWorktreeId) {
      return
    }
    const result = openFileInBrowserTab({ filePath: node.path, worktreeId: activeWorktreeId })
    if (result.status === 'unsupported') {
      toast.error(result.message)
    }
  }, [activeWorktreeId, node.path])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          className={cn(
            'flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-[length:var(--fe-text-size,12px)] transition-colors',
            'text-[var(--fe-text)] hover:bg-[var(--fe-bg-hover)] hover:text-[var(--fe-text)]',
            isSelected && 'bg-[var(--fe-bg-selected)] text-[var(--fe-text-selected)]',
            isFlashing && 'bg-[var(--fe-flash-bg)] ring-1 ring-inset ring-[var(--fe-flash-ring)]'
          )}
          style={{ paddingLeft: `${node.depth * 16 + 8}px` }}
          data-native-file-drop-dir={rowDropDir}
          draggable
          onDragStart={(event) => {
            const paths =
              selectedPaths.has(node.path) && selectedPaths.size > 1
                ? [...selectedPaths]
                : [node.path]
            event.dataTransfer.setData(WORKSPACE_FILE_PATH_MIME, node.path)
            if (paths.length > 1) {
              event.dataTransfer.setData(WORKSPACE_FILE_PATHS_MIME, encodeWorkspaceFilePaths(paths))
            }
            event.dataTransfer.effectAllowed = 'copyMove'
            onDragSourceChange(node.path)

            if (paths.length > 1) {
              const MAX_SHOWN = 5
              const btn = event.currentTarget
              const rowW = btn.getBoundingClientRect().width

              // Why: drag images are detached DOM nodes, so inline the same
              // file glyph the real row renders.
              const FILE_ICON =
                '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><polyline points="14 2 14 8 20 8"/></svg>'

              const makeRow = (label: string, faded = false): HTMLDivElement => {
                const row = document.createElement('div')
                row.style.cssText = `display:flex;align-items:center;gap:4px;height:26px;padding:4px 8px;width:${rowW}px;box-sizing:border-box;font-size:12px;border-radius:2px;background:var(--accent);color:var(--accent-foreground);${faded ? 'opacity:0.6;' : ''}`
                const spacer = document.createElement('span')
                spacer.style.cssText = 'width:12px;height:12px;flex-shrink:0;'
                row.appendChild(spacer)
                const icon = document.createElement('span')
                icon.style.cssText =
                  'width:12px;height:12px;flex-shrink:0;display:flex;align-items:center;color:var(--muted-foreground);'
                icon.innerHTML = FILE_ICON
                row.appendChild(icon)
                const name = document.createElement('span')
                name.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
                name.textContent = label
                row.appendChild(name)
                return row
              }

              const ghost = document.createElement('div')
              ghost.style.cssText =
                'position:fixed;top:-9999px;left:-9999px;pointer-events:none;display:flex;flex-direction:column;gap:1px;'

              for (const p of paths.slice(0, MAX_SHOWN)) {
                ghost.appendChild(makeRow(basename(p)))
              }
              if (paths.length > MAX_SHOWN) {
                ghost.appendChild(makeRow(`+${paths.length - MAX_SHOWN} more`, true))
              }

              document.body.appendChild(ghost)
              event.dataTransfer.setDragImage(ghost, 12, 12)
              setTimeout(() => document.body.removeChild(ghost), 0)
            }
          }}
          onDragEnd={() => onDragSourceChange(null)}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={(e) => onClick(e)}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenuSelect}
        >
          {node.isDirectory ? (
            <>
              <ChevronRight
                className={cn(
                  'shrink-0 text-[var(--fe-icon-folder)] transition-transform',
                  isExpanded && 'rotate-90'
                )}
                style={ICON_STYLE}
              />
              {isLoading ? (
                <Loader2
                  className="shrink-0 animate-spin text-[var(--fe-icon-folder)]"
                  style={ICON_STYLE}
                />
              ) : (
                <ResolvedIcon
                  className={cn('shrink-0', iconThemeMonochrome && 'text-[var(--fe-icon-folder)]')}
                  style={ICON_STYLE}
                />
              )}
            </>
          ) : (
            <>
              <span className="shrink-0" style={ICON_STYLE} />
              {node.isSymlink ? (
                <Link className="shrink-0 text-[var(--fe-icon-file)]" style={ICON_STYLE} />
              ) : (
                <ResolvedIcon
                  className={cn('shrink-0', iconThemeMonochrome && 'text-[var(--fe-icon-file)]')}
                  style={ICON_STYLE}
                />
              )}
            </>
          )}
          <span
            className={cn(
              'truncate',
              isSelected && !nodeStatus && !isIgnored && 'text-[var(--fe-text-selected)]',
              isIgnored && 'italic'
            )}
            style={
              nodeStatus
                ? { color: statusColor ?? undefined }
                : isIgnored
                  ? { color: 'var(--fe-text-ignored)' }
                  : undefined
            }
            onDoubleClick={(e) => {
              // Why: the row itself swallows double-click for "pin preview" /
              // directory toggle. Scope rename to the filename text only so
              // those behaviors stay intact on the icon and empty row area,
              // matching VS Code's rename hotspot.
              e.stopPropagation()
              onStartRename(node)
            }}
          >
            {node.name}
          </span>
          {nodeStatus ? (
            <span
              className="ml-auto shrink-0 text-[length:calc(var(--fe-text-size,12px)*0.83)] font-semibold tracking-wide mr-2"
              style={{ color: statusColor ?? undefined }}
            >
              {STATUS_LABELS[nodeStatus]}
            </span>
          ) : isIgnored ? (
            <CircleSlash
              aria-label="Ignored by .gitignore"
              className="ml-auto size-3 shrink-0 mr-2"
              style={{ color: 'var(--fe-text-ignored)' }}
            />
          ) : null}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent
        className="w-64 bg-[rgba(255,255,255,0.82)] dark:bg-[rgba(0,0,0,0.72)]"
        onPointerUpCapture={stopRightButtonMenuSelection}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <ContextMenuItem onSelect={() => onStartNew('file', targetDir, targetDepth)}>
          <FilePlus />
          New File
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onStartNew('folder', targetDir, targetDepth)}>
          <FolderPlus />
          New Folder
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onCopyPaths('absolute')}>
          <Copy />
          {selectionSize > 1 ? 'Copy Paths' : 'Copy Path'}
          {copyPathShortcutLabel !== 'Unassigned' ? (
            <ContextMenuShortcut>{copyPathShortcutLabel}</ContextMenuShortcut>
          ) : null}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onCopyPaths('relative')}>
          <Copy />
          {selectionSize > 1 ? 'Copy Relative Paths' : 'Copy Relative Path'}
          {copyRelativePathShortcutLabel !== 'Unassigned' ? (
            <ContextMenuShortcut>{copyRelativePathShortcutLabel}</ContextMenuShortcut>
          ) : null}
        </ContextMenuItem>
        {!node.isDirectory && (
          <ContextMenuItem onSelect={() => onDuplicate(node)}>
            <Files />
            Duplicate
          </ContextMenuItem>
        )}
        {!node.isDirectory && activeWorktreeId && (
          <ContextMenuItem onSelect={handleOpenInOrcaBrowser}>
            <Globe />
            Open in Orca Browser
          </ContextMenuItem>
        )}
        {!node.isDirectory && activeWorktreeId && detectLanguage(node.path) === 'markdown' && (
          <ContextMenuItem
            onSelect={() =>
              openMarkdownPreview({
                filePath: node.path,
                relativePath: node.relativePath,
                worktreeId: activeWorktreeId,
                language: 'markdown'
              })
            }
          >
            <Eye />
            Open Markdown Preview
          </ContextMenuItem>
        )}
        {shouldShowCollapseFolderAction(node, isExpanded) && (
          <ContextMenuItem onSelect={onCollapseFolderSubtree}>
            <ListCollapse />
            Collapse Folder
          </ContextMenuItem>
        )}
        {shouldShowFindInFolderAction(node) && (
          <ContextMenuItem onSelect={onFindInFolder}>
            <Search />
            Find in Folder
            {findInFolderShortcutLabel !== 'Unassigned' ? (
              <ContextMenuShortcut>{findInFolderShortcutLabel}</ContextMenuShortcut>
            ) : null}
          </ContextMenuItem>
        )}
        <ContextMenuItem
          onSelect={() => {
            const state = useAppStore.getState()
            const activeWorktree = Object.values(state.worktreesByRepo)
              .flat()
              .find((worktree) => worktree.id === activeWorktreeId)
            const activeRepo = activeWorktree
              ? state.repos.find((repo) => repo.id === activeWorktree.repoId)
              : null
            if (
              isLocalPathOpenBlocked(state.settings, {
                connectionId: activeRepo?.connectionId ?? null
              })
            ) {
              showLocalPathOpenBlockedToast()
              return
            }
            window.api.shell.openPath(node.path)
          }}
        >
          <ExternalLink />
          {revealLabel}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onStartRename(node)}>
          <Pencil />
          Rename
          <ContextMenuShortcut>{isMac ? '↩' : 'Enter'}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={onRequestDelete}>
          <Trash2 />
          Delete
          <ContextMenuShortcut>{deleteShortcutLabel}</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
