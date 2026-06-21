/* eslint-disable max-lines -- Why: the row owns dense file-tree rendering plus its context menu, drag target, and inline-input sibling contract. */
import React, { useCallback, useRef } from 'react'
import { basename } from '@/lib/path'
import {
  ChevronRight,
  CircleSlash,
  Copy,
  Download,
  ExternalLink,
  Eye,
  File,
  FilePlus,
  Files,
  Folder,
  FolderOpen,
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
import { getFileTypeIcon } from '@/lib/file-type-icons'
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
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '@/components/tab-bar/SortableTab'

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
  const focusFrame = useRef<number | null>(null)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refocusFrame = useRef<number | null>(null)
  const inlineInputKey = [
    inlineInput.type,
    inlineInput.parentPath,
    inlineInput.depth,
    inlineInput.existingPath ?? '',
    inlineInput.existingName ?? ''
  ].join('\0')

  const cancelRefocusFrame = useCallback((): void => {
    if (refocusFrame.current !== null) {
      cancelAnimationFrame(refocusFrame.current)
      refocusFrame.current = null
    }
  }, [])

  const scheduleInputRefocus = useCallback((): void => {
    cancelRefocusFrame()
    refocusFrame.current = requestAnimationFrame(() => {
      refocusFrame.current = null
      inputRef.current?.focus()
    })
  }, [cancelRefocusFrame])

  const clearInlineInputTimers = useCallback(() => {
    if (focusFrame.current !== null) {
      cancelAnimationFrame(focusFrame.current)
      focusFrame.current = null
    }
    cancelRefocusFrame()
    if (blurTimeout.current) {
      clearTimeout(blurTimeout.current)
      blurTimeout.current = null
    }
    if (settleTimer.current) {
      clearTimeout(settleTimer.current)
      settleTimer.current = null
    }
  }, [cancelRefocusFrame])

  const setInputRef = useCallback(
    (el: HTMLInputElement | null): void => {
      inputRef.current = el
      clearInlineInputTimers()
      if (!el) {
        return
      }

      submitted.current = false
      focusSettled.current = false

      // Schedule focus after any pending focus-restore from menu close
      focusFrame.current = requestAnimationFrame(() => {
        focusFrame.current = null
        if (inputRef.current !== el) {
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
    },
    [clearInlineInputTimers, inlineInput.existingName, inlineInput.type]
  )

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
      <span className="size-3 shrink-0" />
      {inlineInput.type === 'folder' ? (
        <Folder className="size-3 shrink-0 text-muted-foreground" />
      ) : (
        <File className="size-3 shrink-0 text-muted-foreground" />
      )}
      <input
        key={inlineInputKey}
        ref={setInputRef}
        className="flex-1 min-w-0 bg-transparent text-xs text-foreground outline-none border border-ring rounded-sm px-1"
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
            scheduleInputRefocus()
            return
          }
          // During the grace period after mount, menu close focus management
          // may shift focus away (often relatedTarget is null). Re-focus
          // instead of dismissing the still-empty input.
          if (!focusSettled.current) {
            scheduleInputRefocus()
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
  connectionId?: string | null
  canCollapseFolderSubtree: boolean
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
  onAddFolderAsProject: () => void
  canAddAsProject: boolean
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

export function shouldShowRemoteDownloadAction(
  node: TreeNode,
  connectionId?: string | null
): boolean {
  // Why: Desktop-only because download depends on Electron's native save dialog.
  return (
    !node.isDirectory &&
    Boolean(connectionId) &&
    (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ !== true
  )
}

export async function downloadRemoteFile(node: TreeNode, connectionId: string): Promise<void> {
  try {
    const result = await window.api.fs.downloadFile({ filePath: node.path, connectionId })
    // Why: Suppress toasts when the user cancels the native save dialog per design.
    if (result.canceled) {
      return
    }
    toast.success(
      translate(
        'auto.components.right.sidebar.FileExplorerRow.bce4d4e44f',
        "Downloaded '{{value0}}'",
        { value0: node.name }
      ),
      {
        action: {
          label: translate('auto.components.right.sidebar.FileExplorerRow.1a3df04ae1', 'Open'),
          onClick: () => {
            void window.api.shell.openPath(result.destinationPath)
          }
        }
      }
    )
  } catch (error) {
    toast.error(
      extractIpcErrorMessage(
        error,
        translate(
          'auto.components.right.sidebar.FileExplorerRow.b3e288bf41',
          "Failed to download '{{value0}}'.",
          { value0: node.name }
        )
      )
    )
  }
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
  connectionId,
  canCollapseFolderSubtree,
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
  onAddFolderAsProject,
  canAddAsProject,
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
  const copyPathShortcutLabel = useShortcutLabel('fileExplorer.copyPath')
  const copyRelativePathShortcutLabel = useShortcutLabel('fileExplorer.copyRelativePath')
  const findInFolderShortcutLabel = useShortcutLabel('sidebar.search.toggle')
  const FileIcon = getFileTypeIcon(node.relativePath || node.name)
  const rowDropDir = node.isDirectory ? node.path : targetDir
  const showRemoteDownloadAction = shouldShowRemoteDownloadAction(node, connectionId)
  const { setRowDragNode, handleDragOver, handleDragEnter, handleDragLeave, handleDrop } =
    useFileExplorerRowDrag({
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
  const handleDownload = useCallback(() => {
    if (!connectionId) {
      return
    }
    void downloadRemoteFile(node, connectionId)
  }, [connectionId, node])

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (!open) {
          return
        }
        window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
        onContextMenuSelect()
      }}
    >
      <ContextMenuTrigger asChild>
        <button
          className={cn(
            'flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-xs transition-colors hover:bg-accent hover:text-foreground',
            isSelected && 'bg-accent text-accent-foreground',
            isFlashing && 'bg-amber-400/20 ring-1 ring-inset ring-amber-400/70'
          )}
          style={{ paddingLeft: `${node.depth * 16 + 8}px` }}
          ref={setRowDragNode}
          data-native-file-drop-dir={rowDropDir}
          // Why: marks this draggable row so the wheel-capture handler can rescue
          // scroll Chromium swallows over draggable nodes (file-explorer-drag-scroll-marker).
          data-explorer-draggable="true"
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
                <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
              ) : isExpanded ? (
                <FolderOpen className="size-3 shrink-0 text-muted-foreground" />
              ) : (
                <Folder className="size-3 shrink-0 text-muted-foreground" />
              )}
            </>
          ) : (
            <>
              <span className="size-3 shrink-0" />
              {node.isSymlink ? (
                <Link className="size-3 shrink-0 text-muted-foreground" />
              ) : (
                <FileIcon className="size-3 shrink-0 text-muted-foreground" />
              )}
            </>
          )}
          <span
            className={cn(
              'truncate',
              isSelected && !nodeStatus && !isIgnored && 'text-accent-foreground',
              isIgnored && 'italic'
            )}
            style={
              nodeStatus
                ? { color: statusColor ?? undefined }
                : isIgnored
                  ? { color: 'var(--git-decoration-ignored)' }
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
              className="ml-auto shrink-0 text-[10px] font-semibold tracking-wide mr-2"
              style={{ color: statusColor ?? undefined }}
            >
              {STATUS_LABELS[nodeStatus]}
            </span>
          ) : isIgnored ? (
            <CircleSlash
              aria-label={translate(
                'auto.components.right.sidebar.FileExplorerRow.e26010014a',
                'Ignored by .gitignore'
              )}
              className="ml-auto size-3 shrink-0 mr-2"
              style={{ color: 'var(--git-decoration-ignored)' }}
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
          {translate('auto.components.right.sidebar.FileExplorerRow.37c875d827', 'New File')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onStartNew('folder', targetDir, targetDepth)}>
          <FolderPlus />
          {translate('auto.components.right.sidebar.FileExplorerRow.f61af83316', 'New Folder')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onCopyPaths('absolute')}>
          <Copy />
          {selectionSize > 1
            ? translate('auto.components.right.sidebar.FileExplorerRow.f9d7ca753d', 'Copy Paths')
            : translate('auto.components.right.sidebar.FileExplorerRow.b5d436aa30', 'Copy Path')}
          {copyPathShortcutLabel !== 'Unassigned' ? (
            <ContextMenuShortcut>{copyPathShortcutLabel}</ContextMenuShortcut>
          ) : null}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onCopyPaths('relative')}>
          <Copy />
          {selectionSize > 1
            ? translate(
                'auto.components.right.sidebar.FileExplorerRow.42e10cbf57',
                'Copy Relative Paths'
              )
            : translate(
                'auto.components.right.sidebar.FileExplorerRow.66a29dde82',
                'Copy Relative Path'
              )}
          {copyRelativePathShortcutLabel !== 'Unassigned' ? (
            <ContextMenuShortcut>{copyRelativePathShortcutLabel}</ContextMenuShortcut>
          ) : null}
        </ContextMenuItem>
        {!node.isDirectory && (
          <ContextMenuItem onSelect={() => onDuplicate(node)}>
            <Files />
            {translate('auto.components.right.sidebar.FileExplorerRow.0fec99bfd7', 'Duplicate')}
          </ContextMenuItem>
        )}
        {canAddAsProject && (
          <ContextMenuItem onSelect={onAddFolderAsProject}>
            <FolderPlus />
            {translate(
              'auto.components.right.sidebar.FileExplorerRow.1bb9be455c',
              'Add as Project...'
            )}
          </ContextMenuItem>
        )}
        {!node.isDirectory && activeWorktreeId && (
          <ContextMenuItem onSelect={handleOpenInOrcaBrowser}>
            <Globe />
            {translate(
              'auto.components.right.sidebar.FileExplorerRow.dd112c81d2',
              'Open in Orca Browser'
            )}
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
            {translate(
              'auto.components.right.sidebar.FileExplorerRow.d87a4c42e1',
              'Open Markdown Preview'
            )}
          </ContextMenuItem>
        )}
        {showRemoteDownloadAction && (
          <ContextMenuItem onSelect={handleDownload}>
            <Download />
            {translate('auto.components.right.sidebar.FileExplorerRow.c2112579f6', 'Download')}
          </ContextMenuItem>
        )}
        {canCollapseFolderSubtree && shouldShowCollapseFolderAction(node, isExpanded) && (
          <ContextMenuItem onSelect={onCollapseFolderSubtree}>
            <ListCollapse />
            {translate(
              'auto.components.right.sidebar.FileExplorerRow.d6a25618aa',
              'Collapse Folder'
            )}
          </ContextMenuItem>
        )}
        {shouldShowFindInFolderAction(node) && (
          <ContextMenuItem onSelect={onFindInFolder}>
            <Search />
            {translate(
              'auto.components.right.sidebar.FileExplorerRow.0df0e5abac',
              'Find in Folder'
            )}
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
          {translate('auto.components.right.sidebar.FileExplorerRow.fc747429bf', 'Rename')}
          <ContextMenuShortcut>
            {isMac
              ? '↩'
              : translate('auto.components.right.sidebar.FileExplorerRow.a06551beee', 'Enter')}
          </ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={onRequestDelete}>
          <Trash2 />
          {translate('auto.components.right.sidebar.FileExplorerRow.addc01145f', 'Delete')}
          <ContextMenuShortcut>{deleteShortcutLabel}</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
