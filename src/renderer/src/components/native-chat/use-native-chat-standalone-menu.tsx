import { GitFork } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { NativeChatCliForkMenuItems } from '../tab-bar/NativeChatCliForkMenuItems'
import { AgentSessionContextCopyMenuItem } from '../terminal-pane/AgentSessionContextCopyMenuItem'
import { useNativeChatQuickCommandsMenu } from './use-native-chat-quick-commands-menu'
import {
  useNativeChatSessionContextActions,
  type NativeChatSessionMenuSource
} from './use-native-chat-session-context-actions'

export function useNativeChatStandaloneMenu({
  pane,
  source,
  open,
  close
}: {
  pane: { tabId: string; worktreeId: string; groupId: string } | undefined
  source: NativeChatSessionMenuSource | undefined
  open: boolean
  close: () => void
}) {
  const quickCommands = useNativeChatQuickCommandsMenu(pane, open, close)
  const context = useNativeChatSessionContextActions(source)
  return {
    quickCommands: quickCommands.menu,
    sessionItems:
      pane && source ? (
        <>
          {context.available ? (
            <>
              <DropdownMenuItem disabled={context.pending} onSelect={context.onFork}>
                <GitFork />
                {translate(
                  'auto.components.terminal.pane.TerminalContextMenu.8a7ddb8b8a',
                  'Fork Agent Session…'
                )}
              </DropdownMenuItem>
              <AgentSessionContextCopyMenuItem
                disabled={context.pending}
                onSelect={context.onCopy}
              />
            </>
          ) : null}
          <NativeChatCliForkMenuItems
            tab={{ id: pane.tabId, worktreeId: pane.worktreeId }}
            nativeChat={{ sessionId: source.sessionId, agent: source.agent }}
            leadingSeparator={false}
            menuKind="dropdown"
            onComplete={close}
          />
        </>
      ) : null,
    dialogs: (
      <>
        {quickCommands.dialog}
        {context.dialog}
      </>
    )
  }
}
