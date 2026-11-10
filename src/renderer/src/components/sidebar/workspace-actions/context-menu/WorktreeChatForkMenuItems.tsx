import { GitBranchPlus } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { isTuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { Tab } from '../../../../../../shared/tab-types'
import { openNativeChatWorktreeFork } from '../../../native-chat/messages/actions/NativeChatWorktreeForkMenuItem'
import { useNativeChatWorktreeForkOffered } from '../../../native-chat/messages/actions/native-chat-worktree-fork'

const NO_TABS: readonly Tab[] = []

/** The workspace's chats, most recently used first. */
function workspaceChats(tabs: readonly Tab[]): Tab[] {
  return tabs
    .filter((tab) => tab.contentType === 'agent-session' && isTuiAgent(tab.agentSessionAgent))
    .sort((left, right) => (right.lastFocusedAt ?? 0) - (left.lastFocusedAt ?? 0))
}

/** "Fork Chat into New Worktree": the only chat directly, or a pick of the workspace's chats. */
export function WorktreeChatForkMenuItems({
  worktreeId,
  disabled
}: {
  worktreeId: string
  disabled: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const tabs = useAppStore((state) => state.unifiedTabsByWorktree[worktreeId] ?? NO_TABS)
  const offered = useNativeChatWorktreeForkOffered(worktreeId)
  const chats = workspaceChats(tabs)
  if (chats.length === 0 || !offered) {
    return null
  }
  const label = t('components.native-chat.fork.worktree.sidebarMenu', 'Fork Chat into New Worktree')
  if (chats.length === 1) {
    return (
      <DropdownMenuItem
        disabled={disabled}
        onSelect={() => openNativeChatWorktreeFork({ id: chats[0].id, worktreeId })}
      >
        <GitBranchPlus className="size-3.5" />
        {`${label}…`}
      </DropdownMenuItem>
    )
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>
        <GitBranchPlus className="size-3.5" />
        {label}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {chats.map((chat) => (
          <DropdownMenuItem
            key={chat.id}
            onSelect={() => openNativeChatWorktreeFork({ id: chat.id, worktreeId })}
          >
            <span className="truncate">{chat.customLabel || chat.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
