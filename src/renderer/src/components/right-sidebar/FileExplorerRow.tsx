import React from 'react'
import { ChevronRight, CircleSlash, Folder, FolderOpen, Link, Loader2 } from 'lucide-react'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import {
  encodeWorkspaceFilePaths,
  WORKSPACE_FILE_PATH_MIME,
  WORKSPACE_FILE_PATHS_MIME
} from '@/lib/workspace-file-drag'
import type { GitFileStatus } from '../../../../shared/git-status-types'
import { STATUS_LABELS } from './status-display'
import { RENAME_HOTSPOT_ATTR } from './file-explorer-dir-toggle-timing'
import type { TreeNode } from './file-explorer-types'
import { useFileExplorerRowDrag } from './useFileExplorerRowDrag'
import { translate } from '@/i18n/i18n'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '@/components/tab-bar/SortableTab'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import { createMultiSelectDragGhost } from './file-explorer-multi-drag-image'
import { FileExplorerRowContextMenu } from './file-explorer-row-context-menu'

// ─── File / Folder Row with Context Menu ─────────────────────────

export type FileExplorerRowProps = {
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
  runtimeDownloadContext?: RuntimeFileOperationArgs | null
  supportsFolderDownload?: boolean
  canOpenInOrcaBrowser: boolean
  canCollapseFolderSubtree: boolean
  targetDir: string
  targetDepth: number
  selectionSize: number
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  onDoubleClick: () => void
  onViewFile: () => void
  onContextMenuSelect: () => void
  onCopyPaths: (pathKind: 'absolute' | 'relative') => void
  onStartNew: (type: 'file' | 'folder', dir: string, depth: number) => void
  onStartRename: (node: TreeNode) => void
  onDuplicate: (node: TreeNode) => void
  onAddFolderAsProject: () => void
  canAddAsProject: boolean
  onOpenInTerminal: () => void
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
  runtimeDownloadContext,
  supportsFolderDownload = false,
  canOpenInOrcaBrowser,
  canCollapseFolderSubtree,
  targetDir,
  targetDepth,
  selectionSize,
  onClick,
  onDoubleClick,
  onViewFile,
  onContextMenuSelect,
  onCopyPaths,
  onStartNew,
  onStartRename,
  onDuplicate,
  onAddFolderAsProject,
  canAddAsProject,
  onOpenInTerminal,
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
  const FileIcon = getFileTypeIcon(node.relativePath || node.name)
  const rowDropDir = node.isDirectory ? node.path : targetDir
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
          data-file-explorer-row=""
          data-selected={isSelected ? 'true' : undefined}
          className={cn(
            'flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-xs transition-colors',
            !isSelected && 'hover:bg-accent hover:text-foreground',
            isSelected && 'text-accent-foreground',
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
              const btn = event.currentTarget
              const rowW = btn.getBoundingClientRect().width
              const ghost = createMultiSelectDragGhost(paths, rowW)

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
                React.createElement(FileIcon, {
                  className: 'size-3 shrink-0 text-muted-foreground'
                })
              )}
            </>
          )}
          <span
            // Why: marks the rename hotspot so the row's click handler can hold
            // back the directory toggle until the double-click window closes.
            {...{ [RENAME_HOTSPOT_ATTR]: '' }}
            className={cn(
              'truncate',
              isSelected && !nodeStatus && !isIgnored && 'text-accent-foreground',
              // Why: italic glyphs overhang their advance width; truncate's
              // overflow:hidden clips it, shaving the last char (".md" → ".ma").
              // pr-0.5 reserves room for the slant so the final letter survives.
              isIgnored && 'italic pr-0.5'
            )}
            style={
              nodeStatus
                ? { color: statusColor ?? undefined }
                : isIgnored
                  ? { color: 'var(--git-decoration-ignored)' }
                  : undefined
            }
            onDoubleClick={(e) => {
              // Why: scope rename to the filename text so "pin preview" and the
              // directory toggle stay reachable on the icon and empty row area.
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
      <FileExplorerRowContextMenu
        node={node}
        isExpanded={isExpanded}
        deleteShortcutLabel={deleteShortcutLabel}
        connectionId={connectionId}
        runtimeDownloadContext={runtimeDownloadContext}
        supportsFolderDownload={supportsFolderDownload}
        canOpenInOrcaBrowser={canOpenInOrcaBrowser}
        canCollapseFolderSubtree={canCollapseFolderSubtree}
        targetDir={targetDir}
        targetDepth={targetDepth}
        selectionSize={selectionSize}
        onViewFile={onViewFile}
        onCopyPaths={onCopyPaths}
        onStartNew={onStartNew}
        onStartRename={onStartRename}
        onDuplicate={onDuplicate}
        onAddFolderAsProject={onAddFolderAsProject}
        canAddAsProject={canAddAsProject}
        onOpenInTerminal={onOpenInTerminal}
        onRequestDelete={onRequestDelete}
        onCollapseFolderSubtree={onCollapseFolderSubtree}
        onFindInFolder={onFindInFolder}
      />
    </ContextMenu>
  )
}
