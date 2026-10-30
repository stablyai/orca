import React, { useCallback, useMemo } from 'react'
import { Copy, ExternalLink, Eye, FolderOpen } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { getWorkspaceEditorSshHost } from '@/lib/workspace-editor-ssh-target'
import { OpenInApplicationIcon } from '@/lib/open-in-app-catalog'
import { translate } from '@/i18n/i18n'
import { LocalOnlyMenuHint } from '@/components/local-only-menu-hint'
import {
  getRevealInFileManagerLabel,
  getWorkspaceFileRevealOwner,
  revealInFileManager
} from '@/lib/reveal-in-file-manager'
import {
  getRouteForLocalPathOpenOwner,
  isRevealOrEditorOpenBlocked
} from '@/lib/local-path-open-guard'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { formatClipboardFilePath } from '@/lib/clipboard-file-path'
import type { ConflictResolution } from '../../../../../../shared/source-control-entry-actions'
import { CONFLICT_RESOLUTION_ICONS, getLocalizedConflictResolutionLabel } from './conflict-label'
import { NO_OPEN_IN_APPLICATIONS } from '@/lib/open-in-application-selection'
import {
  getOpenInEntryAvailability,
  openOpenInAppsSettings,
  openWorktreePath
} from '@/components/sidebar/WorktreeOpenInMenu'

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
  const openInApplications = useAppStore(
    (s) => s.settings?.openInApplications ?? NO_OPEN_IN_APPLICATIONS
  )
  // Resolve the repo owner; OS reveal cannot distinguish another host's path from an identically named local path.
  const runtimeEnvironmentId = useAppStore((s) =>
    runtimeEnvironmentIdOrLocalUnlessTwin(s, currentWorktreeId)
  )
  const revealOwner = useAppStore((s) =>
    getWorkspaceFileRevealOwner(s, currentWorktreeId, { connectionId, runtimeEnvironmentId })
  )
  const revealBlocked = isRevealOrEditorOpenBlocked(revealOwner)
  const openInRoute = useMemo(() => getRouteForLocalPathOpenOwner(revealOwner), [revealOwner])
  const runtimeSshHost = useAppStore(
    useShallow((s) => getWorkspaceEditorSshHost(s, { workspaceId: currentWorktreeId }))
  )

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

  const handleOpenInApplication = useCallback(
    (command: string) => {
      if (!absolutePath) {
        return
      }
      void openWorktreePath({
        target: 'external-editor',
        worktreePath: absolutePath,
        ...openInRoute,
        workspace: { workspaceId: currentWorktreeId },
        command
      })
    },
    [absolutePath, currentWorktreeId, openInRoute]
  )

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
        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={!absolutePath}>
            <FolderOpen className="size-3.5" />
            {translate('auto.components.sidebar.WorktreeOpenInMenu.8009ab69a6', 'Open in')}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-52">
            {openInApplications.map((application) => {
              const availability = getOpenInEntryAvailability(
                { ...application, target: 'external-editor' },
                openInRoute.connectionId,
                openInRoute.runtimeEnvironmentId,
                openInRoute.ownerUnresolved,
                runtimeSshHost
              )
              return (
                <ContextMenuItem
                  key={application.id}
                  onSelect={() => handleOpenInApplication(application.command)}
                  disabled={!absolutePath || availability.disabled}
                >
                  {application.command ? (
                    <OpenInApplicationIcon application={application} size={14} />
                  ) : (
                    <ExternalLink className="size-3.5" />
                  )}
                  <span className="min-w-0 truncate">{application.label}</span>
                  {availability.metadata ? (
                    <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                      {availability.metadata}
                    </span>
                  ) : null}
                </ContextMenuItem>
              )
            })}
            {openInApplications.length > 0 ? <ContextMenuSeparator /> : null}
            <ContextMenuItem onSelect={openOpenInAppsSettings}>
              {translate(
                'auto.components.sidebar.WorktreeOpenInMenu.1417fd8380',
                'Customize apps...'
              )}
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
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
