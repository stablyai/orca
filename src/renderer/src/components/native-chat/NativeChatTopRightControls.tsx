import { useInPlaceSwitchCapability } from '@/lib/in-place-switch-support'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import {
  useConversationSwitchBusy,
  useConversationSwitchReadiness,
  runNativeChatCliSwitch
} from '@/lib/conversation-surface-switch'
import { Loader2, SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { AI_VAULT_AGENTS } from '../../../../shared/ai-vault-types'
import { SwitchToCliTooltipText } from '../right-sidebar/ai-vault-session-cli-fork-copy'
import { NativeChatFindBar } from './NativeChatFindBar'
import type { NativeChatFind } from './use-native-chat-find'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import { useNativeChatTabOwnerWorktreeId } from './use-native-chat-tab-owner'
import { useNativeChatExecutionHost } from './use-native-chat-execution-host'

/** The chat's top-right corner: its find bar while open, else its icon-only "Switch to CLI". */
export function NativeChatTopRightControls({
  find,
  session,
  inline = false
}: {
  find: NativeChatFind
  session: Pick<NativeChatStructuredViewProps, 'tabId' | 'sessionId' | 'agent' | 'isVisible'>
  working: boolean
  inline?: boolean
}): React.JSX.Element | null {
  const worktreeId = useNativeChatTabOwnerWorktreeId(session.tabId)
  // The chat's host is where its History row lives.
  const hostId = useNativeChatExecutionHost(
    session.tabId,
    worktreeId,
    session.sessionId,
    session.agent
  )
  const agent = AI_VAULT_AGENTS.find((candidate) => candidate === session.agent)
  const inPlace = useInPlaceSwitchCapability(hostId, agent)
  const confirm = useConfirmationDialog()
  const readiness = useConversationSwitchReadiness(
    worktreeId && hostId && agent
      ? {
          direction: 'terminal',
          sessionId: session.sessionId,
          workspaceId: worktreeId,
          executionHostId: hostId,
          agent,
          chatTabId: session.tabId
        }
      : null
  )
  const busy = useConversationSwitchBusy(readiness.pending)

  if (find.isOpen) {
    return <NativeChatFindBar find={find} isVisible={session.isVisible} />
  }
  // A host that answered no gets the header's copy entry instead; unknown shows this disabled.
  if (!worktreeId || !hostId || !agent || inPlace === false) {
    return null
  }
  const label = translate('components.tab.bar.switch.toCli', 'Switch to CLI')
  return (
    <div className={inline ? 'flex' : 'absolute top-2 right-4 z-20'}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant={inline ? 'pane-title' : 'ghost'}
            size="icon-xs"
            aria-label={label}
            aria-disabled={!readiness.ready || undefined}
            disabled={!readiness.ready}
            onClick={() => {
              if (readiness.ready) {
                void runNativeChatCliSwitch({
                  confirm,
                  sessionId: session.sessionId,
                  workspaceId: worktreeId,
                  executionHostId: hostId,
                  agent,
                  chatTabId: session.tabId
                })
              }
            }}
          >
            {busy ? <Loader2 className="animate-spin" /> : <SquareTerminal />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {readiness.explanation ?? <SwitchToCliTooltipText agent={agent} />}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
