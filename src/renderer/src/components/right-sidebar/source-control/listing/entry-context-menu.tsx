import React, { useCallback } from 'react'
import { Copy, ExternalLink, Eye, FolderOpen } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { LocalOnlyMenuHint } from '@/components/local-only-menu-hint'
import {
  getRevealInFileManagerLabel,
  getWorkspaceFileRevealOwner,
  revealInFileManager
} from '@/lib/reveal-in-file-manager'
import { isRevealOrEditorOpenBlocked } from '@/lib/local-path-open-guard'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { formatClipboardFilePath } from '@/lib/clipboard-file-path'
import type { ConflictResolution } from '../../../../../../shared/source-control-entry-actions'
import { CONFLICT_RESOLUTION_ICONS, getLocalizedConflictResolutionLabel } from './conflict-label'
import { OpenInContextSubmenu } from '@/components/right-sidebar/open-in-context-submenu'

type SourceControlEntryContextMenuProps = {
  currentWorktreeId: string
  absolutePath?: string
  relativePath?: string
  /** False for a deleted entry: there is no file for the OS file manager to show. */
  hasWorkingTreeFile: boolean
  connectionId?: string | null
  onView?: () => void
  conflictResolutions?: readonly ConflictResolution[]
  onResolveConflict?: (resolution: ConflictResolution) => void
  onRevealInExplorer: (worktreeId: string, absolutePath: string) => void
  onOpenChange?: (open: boolean) => void
  children: React.ReactNode
}

export function SourceControlEntryContextMenu({
  currentWorktreeId,
  absolutePath,
  relativePath,
  hasWorkingTreeFile,
  connectionId,
  onView,
  conflictResolutions,
  onResolveConflict,
  onRevealInExplorer,
  onOpenChange,
  children
}: SourceControlEntryContextMenuProps): React.JSX.Element {
  // Resolve the repo owner; OS reveal cannot distinguish another host's path from an identically named local path.
  const runtimeEnvironmentId = useAppStore((s) =>
    runtimeEnvironmentIdOrLocalUnlessTwin(s, currentWorktreeId)
  )
  const revealOwner = useAppStore((s) =>
    getWorkspaceFileRevealOwner(s, currentWorktreeId, { connectionId, runtimeEnvironmentId })
  )
  const revealBlocked = isRevealOrEditorOpenBlocked(revealOwner)

  const handleCopyPath = useCallback(() => {
    if (!absolutePath) {
      return
    }
    void window.api.ui.writeClipboardText(formatClipboardFilePath(absolutePath, revealOwner))
  }, [absolutePath, revealOwner])

  const handleCopyRelativePath = useCallback(() => {
    if (!relativePath) {
      return
    }
    void window.api.ui.writeClipboardText(relativePath)
  }, [relativePath])

  const handleRevealInOrcaExplorer = useCallback(() => {
    if (!absolutePath) {
      return
    }
    onRevealInExplorer(currentWorktreeId, absolutePath)
  }, [absolutePath, currentWorktreeId, onRevealInExplorer])

  const handleRevealInFileManager = useCallback(() => {
    if (absolutePath) {
      void revealInFileManager(absolutePath, revealOwner)
    }
  }, [absolutePath, revealOwner])

  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={onView} disabled={!onView}>
          <Eye className="size-3.5" />
          {translate(
            'auto.components.right.sidebar.SourceControlEntryContextMenu.a1f2c8d901',
            'View'
          )}
        </ContextMenuItem>
        {onResolveConflict && conflictResolutions && conflictResolutions.length > 0 ? (
          <>
            <ContextMenuSeparator />
            {conflictResolutions.map((resolution) => {
              const Icon = CONFLICT_RESOLUTION_ICONS[resolution]
              return (
                <ContextMenuItem key={resolution} onSelect={() => onResolveConflict(resolution)}>
                  <Icon className="size-3.5" />
                  {getLocalizedConflictResolutionLabel(resolution)}
                </ContextMenuItem>
              )
            })}
          </>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={handleCopyPath} disabled={!absolutePath}>
          <Copy className="size-3.5" />
          {translate('auto.components.right.sidebar.FileExplorerRow.b5d436aa30', 'Copy Path')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={handleCopyRelativePath} disabled={!relativePath}>
          <Copy className="size-3.5" />
          {translate(
            'auto.components.right.sidebar.FileExplorerRow.66a29dde82',
            'Copy Relative Path'
          )}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <OpenInContextSubmenu
          path={absolutePath}
          workspaceId={currentWorktreeId}
          owner={revealOwner}
        />
        <ContextMenuItem
          onSelect={handleRevealInFileManager}
          disabled={!absolutePath || !hasWorkingTreeFile || revealBlocked}
        >
          <ExternalLink className="size-3.5" />
          {getRevealInFileManagerLabel()}
          {revealBlocked ? <LocalOnlyMenuHint /> : null}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={handleRevealInOrcaExplorer} disabled={!absolutePath}>
          <FolderOpen className="size-3.5" />
          {translate(
            'auto.components.right.sidebar.SourceControl.cc05b2d088',
            'Open in File Explorer'
          )}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
