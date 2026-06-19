import React, { useCallback } from 'react'
import { FolderOpen } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { translate } from '@/i18n/i18n'

export function SourceControlEntryContextMenu({
  currentWorktreeId,
  absolutePath,
  onRevealInExplorer,
  onOpenChange,
  children
}: {
  currentWorktreeId: string
  absolutePath?: string
  onRevealInExplorer: (worktreeId: string, absolutePath: string) => void
  onOpenChange?: (open: boolean) => void
  children: React.ReactNode
}): React.JSX.Element {
  const handleOpenInFileExplorer = useCallback(() => {
    if (!absolutePath) {
      return
    }
    onRevealInExplorer(currentWorktreeId, absolutePath)
  }, [absolutePath, currentWorktreeId, onRevealInExplorer])

  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={handleOpenInFileExplorer} disabled={!absolutePath}>
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
