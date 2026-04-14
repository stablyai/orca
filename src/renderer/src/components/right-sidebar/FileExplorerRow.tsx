import React, { useCallback, useEffect, useRef } from 'react'
import {
  ChevronRight,
  Copy,
  ExternalLink,
  File,
  FilePlus,
  Files,
  Folder,
  FolderOpen,
  FolderPlus,
  Loader2,
  Pencil,
  Trash2
} from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import type { GitFileStatus } from '../../../../shared/types'
import { STATUS_LABELS } from './status-display'
import type { TreeNode } from './file-explorer-types'
import { useFileExplorerRowDrag } from './useFileExplorerRowDrag'

const ORCA_PATH_MIME = 'text/x-orca-file-path'

const isMac = navigator.userAgent.includes('Mac')
const isLinux = navigator.userAgent.includes('Linux')

/** Platform-appropriate label: macOS → Finder, Windows → File Explorer, Linux → Files */
const revealLabel = isMac
  ? 'Reveal in Finder'
  : isLinux
    ? 'Open Containing Folder'
    : 'Reveal in File Explorer'

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
      <span className="size-3 shrink-0" />
      {inlineInput.type === 'folder' ? (
        <Folder className="size-3 shrink-0 text-muted-foreground" />
      ) : (
        <File className="size-3 shrink-0 text-muted-foreground" />
      )}
      <input
        ref={inputRef}
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
  nodeStatus: GitFileStatus | null
  statusColor: string | null
  deleteShortcutLabel: string
  targetDir: string
  targetDepth: number
  onClick: () => void
  onDoubleClick: () => void
  onSelect: () => void
  onStartNew: (type: 'file' | 'folder', dir: string, depth: number) => void
  onStartRename: (node: TreeNode) => void
  onDuplicate: (node: TreeNode) => void
  onRequestDelete: () => void
  onMoveDrop: (sourcePath: string, destDir: string) => void
  onDragTargetChange: (dir: string | null) => void
  onDragSourceChange: (path: string | null) => void
  onDragExpandDir: (dirPath: string) => void
  onNativeDragTargetChange: (dir: string | null) => void
  onNativeDragExpandDir: (dirPath: string) => void
}

export function FileExplorerRow({
  node,
  isExpanded,
  isLoading,
  isSelected,
  isFlashing,
  nodeStatus,
  statusColor,
  deleteShortcutLabel,
  targetDir,
  targetDepth,
  onClick,
  onDoubleClick,
  onSelect,
  onStartNew,
  onStartRename,
  onDuplicate,
  onRequestDelete,
  onMoveDrop,
  onDragTargetChange,
  onDragSourceChange,
  onDragExpandDir,
  onNativeDragTargetChange,
  onNativeDragExpandDir
}: FileExplorerRowProps): React.JSX.Element {
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

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          className={cn(
            'flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-xs transition-colors hover:bg-accent hover:text-foreground',
            isSelected && 'bg-accent text-accent-foreground',
            isFlashing && 'bg-amber-400/20 ring-1 ring-inset ring-amber-400/70'
          )}
          style={{ paddingLeft: `${node.depth * 16 + 8}px` }}
          data-native-file-drop-dir={rowDropDir}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData(ORCA_PATH_MIME, node.path)
            // Allow both file explorer moving and copying to terminal
            event.dataTransfer.effectAllowed = 'copyMove'
            onDragSourceChange(node.path)
          }}
          onDragEnd={() => onDragSourceChange(null)}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          onFocus={onSelect}
          onContextMenu={onSelect}
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
              <File className="size-3 shrink-0 text-muted-foreground" />
            </>
          )}
          <span
            className={cn('truncate', isSelected && !nodeStatus && 'text-accent-foreground')}
            style={nodeStatus ? { color: statusColor ?? undefined } : undefined}
          >
            {node.name}
          </span>
          {nodeStatus && (
            <span
              className="ml-auto shrink-0 text-[10px] font-semibold tracking-wide mr-2"
              style={{ color: statusColor ?? undefined }}
            >
              {STATUS_LABELS[nodeStatus]}
            </span>
          )}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent
        className="w-64 bg-[rgba(255,255,255,0.82)] dark:bg-[rgba(0,0,0,0.72)]"
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
        <ContextMenuItem onSelect={() => window.api.ui.writeClipboardText(node.path)}>
          <Copy />
          Copy Path
          <ContextMenuShortcut>{isMac ? '⌥⌘C' : 'Shift+Alt+C'}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => window.api.ui.writeClipboardText(node.relativePath)}>
          <Copy />
          Copy Relative Path
          <ContextMenuShortcut>{isMac ? '⌥⇧⌘C' : 'Ctrl+Shift+Alt+C'}</ContextMenuShortcut>
        </ContextMenuItem>
        {!node.isDirectory && (
          <ContextMenuItem onSelect={() => onDuplicate(node)}>
            <Files />
            Duplicate
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => window.api.shell.openPath(node.path)}>
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
