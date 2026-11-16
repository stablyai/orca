import { useAgentStatus } from '@/runtime/agent-status/use-agent-status'
import { useMemo } from 'react'
import { PanelBottomClose, PanelRightClose, X } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { structuredAgentSessionPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { NativeChatProviderSessionIdMenuItem } from './NativeChatProviderSessionIdMenuItem'
import { NativeChatCopyOrcaSessionIdMenuItem } from './NativeChatCopyOrcaSessionIdMenuItem'
import { useStructuredChatPaneActions } from './use-structured-chat-pane-actions'

export function NativeChatStructuredPaneMenuItems({
  pane,
  leadingSeparator,
  splitShortcutLabels,
  resolveOrcaSessionId
}: {
  pane: { tabId: string; worktreeId: string; groupId: string; sessionId: string }
  leadingSeparator: boolean
  splitShortcutLabels?: { right: string; down: string }
  resolveOrcaSessionId?: () => Promise<string | null>
}): React.JSX.Element {
  const t = useTranslate()
  const actions = useStructuredChatPaneActions(pane.tabId, pane.worktreeId, pane.groupId)
  const closeShortcut = useShortcutLabel('tab.close')
  // Why: hashing the key inside the selector would rerun it on every store write.
  const paneKey = useMemo(
    () => structuredAgentSessionPaneKey(pane.tabId, pane.sessionId),
    [pane.tabId, pane.sessionId]
  )
  const providerSessionId = useAgentStatus(paneKey)?.providerSession?.id
  return (
    <>
      {leadingSeparator ? <DropdownMenuSeparator /> : null}
      <DropdownMenuItem onSelect={actions.onSplitRight}>
        <PanelRightClose />
        {t('components.native-chat.splitRight', 'Split Right')}
        <DropdownMenuShortcut>{splitShortcutLabels?.right}</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={actions.onSplitDown}>
        <PanelBottomClose />
        {t('components.native-chat.splitDown', 'Split Down')}
        <DropdownMenuShortcut>{splitShortcutLabels?.down}</DropdownMenuShortcut>
      </DropdownMenuItem>
      {providerSessionId || resolveOrcaSessionId ? (
        <>
          <DropdownMenuSeparator />
          {providerSessionId ? (
            <NativeChatProviderSessionIdMenuItem sessionId={providerSessionId} />
          ) : null}
          {resolveOrcaSessionId ? (
            <NativeChatCopyOrcaSessionIdMenuItem resolveOrcaSessionId={resolveOrcaSessionId} />
          ) : null}
        </>
      ) : null}
      {actions.canClosePane ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={actions.onClosePane}>
            <X />
            {actions.closeLabel}
            <DropdownMenuShortcut>{closeShortcut}</DropdownMenuShortcut>
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  )
}
