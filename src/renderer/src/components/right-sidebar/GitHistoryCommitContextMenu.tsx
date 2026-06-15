import type React from 'react'
import { Copy, Globe, Hash, Sparkles } from 'lucide-react'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator
} from '@/components/ui/context-menu'
import { translate } from '@/i18n/i18n'
import type { GitHistoryItem } from '../../../../shared/git-history'

export type GitHistoryCommitAction = 'open-remote' | 'copy-hash' | 'copy-message' | 'explain'

export function GitHistoryCommitContextMenu({
  item,
  onAction
}: {
  item: GitHistoryItem
  onAction: (action: GitHistoryCommitAction, item: GitHistoryItem) => void
}): React.JSX.Element {
  return (
    <ContextMenuContent className="w-56">
      <ContextMenuItem onSelect={() => onAction('open-remote', item)}>
        <Globe className="size-3.5" />
        {translate(
          'auto.components.right.sidebar.GitHistoryCommitContextMenu.8e5b',
          'Open commit in browser'
        )}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onAction('copy-hash', item)}>
        <Hash className="size-3.5" />
        {translate(
          'auto.components.right.sidebar.GitHistoryCommitContextMenu.9f60',
          'Copy commit hash'
        )}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onAction('copy-message', item)}>
        <Copy className="size-3.5" />
        {translate(
          'auto.components.right.sidebar.GitHistoryCommitContextMenu.a071',
          'Copy commit message'
        )}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => onAction('explain', item)}>
        <Sparkles className="size-3.5" />
        {translate(
          'auto.components.right.sidebar.GitHistoryCommitContextMenu.b182',
          'Explain changes'
        )}
      </ContextMenuItem>
    </ContextMenuContent>
  )
}
