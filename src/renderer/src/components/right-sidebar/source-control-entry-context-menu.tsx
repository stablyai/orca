import React, { useCallback } from 'react'
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
import { useAppStore } from '@/store'
import { OpenInApplicationIcon } from '@/lib/open-in-app-catalog'
import { translate } from '@/i18n/i18n'
import { getLocalFileManagerLabel } from '@/lib/local-file-manager-label'
import {
  getOpenInEntryAvailability,
  getWorktreeOpenInEntries,
  openOpenInAppsSettings,
  openWorktreePath
} from '@/components/sidebar/WorktreeOpenInMenu'

type SourceControlEntryContextMenuProps = {
  currentWorktreeId: string
  absolutePath?: string
  connectionId?: string | null
  onView?: () => void
  onRevealInExplorer: (worktreeId: string, absolutePath: string) => void
  onOpenChange?: (open: boolean) => void
  children: React.ReactNode
}

export function SourceControlEntryContextMenu({
  currentWorktreeId,
  absolutePath,
  connectionId,
  onView,
  onRevealInExplorer,
  onOpenChange,
  children
}: SourceControlEntryContextMenuProps): React.JSX.Element {
  const openInApplications = useAppStore((s) => s.settings?.openInApplications ?? [])
  const settings = useAppStore((s) => s.settings)
  const fileManagerLabel = getLocalFileManagerLabel()
  const openInEntries = React.useMemo(
    () => getWorktreeOpenInEntries(openInApplications, fileManagerLabel),
    [fileManagerLabel, openInApplications]
  )

  const handleCopyPath = useCallback(() => {
    if (!absolutePath) {
      return
    }
    void window.api.ui.writeClipboardText(absolutePath)
  }, [absolutePath])

  const handleRevealInOrcaExplorer = useCallback(() => {
    if (!absolutePath) {
      return
    }
    onRevealInExplorer(currentWorktreeId, absolutePath)
  }, [absolutePath, currentWorktreeId, onRevealInExplorer])

  const handleOpenInExternal = useCallback(
    (target: 'file-manager' | 'external-editor', command?: string) => {
      if (!absolutePath) {
        return
      }
      void openWorktreePath({
        target,
        worktreePath: absolutePath,
        connectionId,
        command
      })
    },
    [absolutePath, connectionId]
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
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={handleCopyPath} disabled={!absolutePath}>
          <Copy className="size-3.5" />
          {translate('auto.components.right.sidebar.FileExplorerRow.b5d436aa30', 'Copy Path')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={!absolutePath}>
            <FolderOpen className="size-3.5" />
            {translate('auto.components.sidebar.WorktreeOpenInMenu.8009ab69a6', 'Open in')}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-52">
            {openInEntries.map((entry) => {
              const availability = getOpenInEntryAvailability(entry, settings, connectionId)
              return (
                <ContextMenuItem
                  key={entry.id}
                  onSelect={() => handleOpenInExternal(entry.target, entry.command)}
                  disabled={!absolutePath || availability.disabled}
                >
                  {entry.target === 'file-manager' ? (
                    <FolderOpen className="size-3.5" />
                  ) : entry.command ? (
                    <OpenInApplicationIcon application={{ command: entry.command }} size={14} />
                  ) : (
                    <ExternalLink className="size-3.5" />
                  )}
                  <span className="min-w-0 truncate">{entry.label}</span>
                  {availability.metadata ? (
                    <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                      {availability.metadata}
                    </span>
                  ) : null}
                </ContextMenuItem>
              )
            })}
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={openOpenInAppsSettings}>
              {translate(
                'auto.components.sidebar.WorktreeOpenInMenu.1417fd8380',
                'Customize apps...'
              )}
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
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
