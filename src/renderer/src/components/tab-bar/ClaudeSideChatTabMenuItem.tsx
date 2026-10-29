import { MessageSquarePlus } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuShortcut } from '@/components/ui/dropdown-menu'
import {
  TOGGLE_CLAUDE_SIDE_CHAT_EVENT,
  type ToggleClaudeSideChatDetail
} from '@/constants/terminal'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { tabHasClaudePane } from '../terminal-pane/claude-side-chat-actions'

/** The tab menu's route to a Claude side chat; the mounted pane picks which Claude pane it forks. */
export function ClaudeSideChatTabMenuItem({
  tabId,
  isActive,
  onActivate
}: {
  tabId: string
  isActive: boolean
  onActivate: (tabId: string) => void
}): React.JSX.Element | null {
  const hasClaudePane = useAppStore((state) => tabHasClaudePane(state, tabId))
  const shortcut = useOptionalShortcutLabel('terminal.toggleSideChat')
  if (!hasClaudePane) {
    return null
  }
  const openSideChat = (): void => {
    if (!isActive) {
      onActivate(tabId)
    }
    const detail: ToggleClaudeSideChatDetail = { tabId }
    window.dispatchEvent(new CustomEvent(TOGGLE_CLAUDE_SIDE_CHAT_EVENT, { detail }))
  }
  return (
    <DropdownMenuItem onSelect={openSideChat}>
      <MessageSquarePlus className="size-3.5 shrink-0" />
      {translate('components.claudeSideChat.open', 'Open Side Chat')}
      {shortcut ? <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut> : null}
    </DropdownMenuItem>
  )
}
