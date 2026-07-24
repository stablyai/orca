import type React from 'react'
import { Copy, FileDiff, Globe, Hash } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { GitHistoryItem } from '../../../../shared/git-history'
import type { GitBranchChangeEntry } from '../../../../shared/types'

export type GitHistoryCommitFileAction =
  | 'open-diff'
  | 'open-browser'
  | 'copy-relative-path'
  | 'copy-commit-hash'

export function GitHistoryCommitFileContextMenu({
  item,
  entry,
  onAction,
  children
}: {
  item: GitHistoryItem
  entry: GitBranchChangeEntry
  onAction: (
    action: GitHistoryCommitFileAction,
    item: GitHistoryItem,
    entry: GitBranchChangeEntry
  ) => void
  children: React.ReactElement
}): React.JSX.Element {
  const browserActionDisabled = entry.status === 'deleted' && !item.parentIds[0]

  return (
    <ContextMenu>
      <TooltipTrigger asChild>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      </TooltipTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem onSelect={() => onAction('open-diff', item, entry)}>
          <FileDiff className="size-3.5" />
          {translate(
            'auto.components.right.sidebar.GitHistoryCommitFileContextMenu.d4a67b210f',
            'Open Diff'
          )}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={browserActionDisabled}
          onSelect={() => onAction('open-browser', item, entry)}
        >
          <Globe className="size-3.5" />
          {translate(
            'auto.components.right.sidebar.GitHistoryCommitFileContextMenu.e5b78c3210',
            'Open in Browser'
          )}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onAction('copy-relative-path', item, entry)}>
          <Copy className="size-3.5" />
          {translate(
            'auto.components.right.sidebar.GitHistoryCommitFileContextMenu.f6c89d4321',
            'Copy Relative Path'
          )}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onAction('copy-commit-hash', item, entry)}>
          <Hash className="size-3.5" />
          {translate(
            'auto.components.right.sidebar.GitHistoryCommitFileContextMenu.a7d90e5432',
            'Copy Commit Hash'
          )}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
