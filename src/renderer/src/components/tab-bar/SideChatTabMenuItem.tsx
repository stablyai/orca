import { MessageSquarePlus } from 'lucide-react'
import { ContextMenuItem, ContextMenuShortcut } from '@/components/ui/context-menu'
import { TOGGLE_SIDE_CHAT_EVENT, type ToggleSideChatDetail } from '@/constants/terminal'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { tabHasSideChatAgentPane } from '../terminal-pane/side-chat/side-chat-actions'

/** The tab menu's route to a side chat; the mounted pane picks which agent pane it forks. */
export function SideChatTabMenuItem({
  tabId,
  isActive,
  onActivate
}: {
  tabId: string
  isActive: boolean
  onActivate: (tabId: string) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const hasSideChatAgentPane = useAppStore((state) => tabHasSideChatAgentPane(state, tabId))
  const shortcut = useOptionalShortcutLabel('terminal.toggleSideChat')
  if (!hasSideChatAgentPane) {
    return null
  }
  const openSideChat = (): void => {
    if (!isActive) {
      onActivate(tabId)
    }
    const detail: ToggleSideChatDetail = { tabId }
    window.dispatchEvent(new CustomEvent(TOGGLE_SIDE_CHAT_EVENT, { detail }))
  }
  return (
    <ContextMenuItem onSelect={openSideChat}>
      <MessageSquarePlus className="size-3.5 shrink-0" />
      {t('components.sideChat.open', 'Open Side Chat')}
      {shortcut ? <ContextMenuShortcut>{shortcut}</ContextMenuShortcut> : null}
    </ContextMenuItem>
  )
}
