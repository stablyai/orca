import { GitBranchPlus } from 'lucide-react'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { useNativeChatWorktreeForkOffered } from './native-chat-worktree-fork'
import { requestNativeChatWorktreeFork } from './native-chat-worktree-fork-requests'

/** Shows the chat tab, then asks its pane to fork it into a new worktree. */
export function openNativeChatWorktreeFork(tab: { id: string; worktreeId: string }): void {
  useAppStore.getState().activateTab(tab.id, { worktreeId: tab.worktreeId })
  requestNativeChatWorktreeFork(tab.id)
}

/** "Fork into New Worktree…" for a chat tab in a git worktree. */
export function NativeChatWorktreeForkMenuItem({
  tab,
  menuKind,
  onComplete
}: {
  tab: { id: string; worktreeId: string }
  menuKind: 'context' | 'dropdown'
  onComplete?: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const offered = useNativeChatWorktreeForkOffered(tab.worktreeId)
  if (!offered) {
    return null
  }
  const Item = menuKind === 'context' ? ContextMenuItem : DropdownMenuItem
  return (
    <Item
      onSelect={() => {
        openNativeChatWorktreeFork(tab)
        onComplete?.()
      }}
    >
      <GitBranchPlus className="size-4" />
      {t('components.native-chat.fork.worktree.menu', 'Fork into New Worktree…')}
    </Item>
  )
}
