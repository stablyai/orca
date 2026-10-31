import { SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { agentLabel } from '../../../../shared/ai-vault-session-filters'
import { AI_VAULT_AGENTS } from '../../../../shared/ai-vault-types'
import { useInPlaceSwitchCapability } from '@/lib/in-place-switch-support'
import {
  runNativeChatCliFork,
  useNativeChatCliForkPending
} from '../tab-bar/native-chat-cli-fork-run'
import {
  resolveTabSessionHistorySubject,
  type NativeChatTabSession
} from '../tab-bar/tab-session-history-switch'
import { useNativeChatExecutionHost } from './use-native-chat-execution-host'

export function NativeChatResumeInCliButton({
  tabId,
  worktreeId,
  nativeChat
}: {
  tabId: string
  worktreeId: string
  nativeChat: NativeChatTabSession
}): React.JSX.Element | null {
  const tab = { id: tabId, worktreeId }
  const { sessionId, agent: nativeAgent } = nativeChat
  const executionHostScope = useNativeChatExecutionHost(tabId, worktreeId, sessionId, nativeAgent)
  const pending = useNativeChatCliForkPending(
    executionHostScope ? { executionHostScope, sessionId: nativeChat.sessionId } : null
  )
  const commandOverrides = useAppStore((state) => state.settings?.agentCmdOverrides)
  const agent = AI_VAULT_AGENTS.find((candidate) => candidate === nativeChat.agent)
  const inPlace = useInPlaceSwitchCapability(executionHostScope, agent)
  const label = translate(
    'components.tab.bar.SortableTabContextMenu.switchToTerminalView',
    'Continue with Terminal Agent'
  )
  // Where the host switches this agent in place (or hasn't answered yet) the top-right switch shows instead.
  if (!executionHostScope || !agent || inPlace !== false) {
    return null
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="pane-title"
          size="icon-xs"
          aria-label={label}
          disabled={pending}
          aria-busy={pending || undefined}
          onClick={(event) => {
            event.stopPropagation()
            const subject = resolveTabSessionHistorySubject(useAppStore.getState(), {
              tab,
              nativeChat
            })
            if (subject?.kind === 'chat') {
              void runNativeChatCliFork({
                subject,
                tab,
                agent,
                commandOverrides,
                queuedMessage: translate(
                  'components.tab.bar.switch.legacyCopy',
                  'A copy of this {{agent}} conversation opens in a new terminal. The original chat stays open.',
                  { agent: agentLabel(agent) }
                )
              })
            }
          }}
        >
          <SquareTerminal className="size-3" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
