import { RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import type { AgentSessionRestartAgentResult } from '../../../../../../shared/agent-session/agent-session-restart-agent'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'

/** Stops the chat's agent; the next send starts it on the selected account, login and settings. */
export function NativeChatRestartAgentMenuItem({
  target,
  sessionId
}: {
  target: RuntimeClientTarget
  sessionId: string
}): React.JSX.Element {
  const t = useTranslate()
  const restart = async (force: boolean): Promise<void> => {
    let result: AgentSessionRestartAgentResult
    try {
      result = await callStructuredAgentSession<AgentSessionRestartAgentResult>(
        target,
        'agentSession.restartAgent',
        force ? { sessionId, force } : { sessionId }
      )
    } catch (error) {
      toast.error(
        t('components.native-chat.contextMenu.restartAgentFailed', 'Could not restart the agent.'),
        { description: error instanceof Error ? error.message : undefined }
      )
      return
    }
    if (result.restarted) {
      toast.success(
        t(
          'components.native-chat.contextMenu.restartAgentDone',
          'Agent stopped. Your next message starts it with the current account.'
        )
      )
    } else if (result.reason === 'not-running') {
      toast(
        t(
          'components.native-chat.contextMenu.restartAgentNotRunning',
          'The agent is not running. Your next message starts it with the current account.'
        )
      )
    } else if (result.reason === 'busy') {
      toast.error(
        t(
          'components.native-chat.contextMenu.restartAgentBusy',
          'The agent is working. Stop the turn or answer its question first.'
        )
      )
    } else {
      toast(
        t(
          'components.native-chat.contextMenu.restartAgentBackgroundWork',
          'The agent still has background tasks. Restarting stops them.'
        ),
        {
          action: {
            label: t('components.native-chat.contextMenu.restartAgentForce', 'Restart Anyway'),
            onClick: () => void restart(true)
          }
        }
      )
    }
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenuItem onSelect={() => void restart(false)}>
          <RotateCw />
          {t('components.native-chat.contextMenu.restartAgent', 'Restart Agent')}
        </DropdownMenuItem>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} className="max-w-[220px]">
        {t(
          'components.native-chat.contextMenu.restartAgentTooltip',
          'Stops this chat’s agent. Your next message starts it again with the current account and settings, and the conversation continues.'
        )}
      </TooltipContent>
    </Tooltip>
  )
}
