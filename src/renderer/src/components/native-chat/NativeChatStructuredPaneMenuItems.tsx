import { PanelBottomClose, PanelRightClose, X } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { NativeChatProviderSessionIdMenuItem } from './NativeChatProviderSessionIdMenuItem'
import { NativeChatCopyOrcaSessionIdMenuItem } from './NativeChatCopyOrcaSessionIdMenuItem'
import { useStructuredChatPaneActions } from './use-structured-chat-pane-actions'

export function NativeChatStructuredPaneMenuItems({
  pane,
  leadingSeparator,
  splitShortcutLabels,
  resolveOrcaSessionId
}: {
  pane: { tabId: string; worktreeId: string; groupId: string; providerSessionId?: string }
  leadingSeparator: boolean
  splitShortcutLabels?: { right: string; down: string }
  resolveOrcaSessionId?: () => Promise<string | null>
}): React.JSX.Element {
  const actions = useStructuredChatPaneActions(pane.tabId, pane.worktreeId, pane.groupId)
  const closeShortcut = useShortcutLabel('tab.close')
  return (
    <>
      {leadingSeparator ? <DropdownMenuSeparator /> : null}
      <DropdownMenuItem onSelect={actions.onSplitRight}>
        <PanelRightClose />
        {translate('auto.components.cmd.j.quick.actions.splitChatRight', 'Split Chat Right')}
        <DropdownMenuShortcut>{splitShortcutLabels?.right}</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={actions.onSplitDown}>
        <PanelBottomClose />
        {translate('auto.components.cmd.j.quick.actions.splitChatDown', 'Split Chat Down')}
        <DropdownMenuShortcut>{splitShortcutLabels?.down}</DropdownMenuShortcut>
      </DropdownMenuItem>
      {pane.providerSessionId || resolveOrcaSessionId ? (
        <>
          <DropdownMenuSeparator />
          {pane.providerSessionId ? (
            <NativeChatProviderSessionIdMenuItem sessionId={pane.providerSessionId} />
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
