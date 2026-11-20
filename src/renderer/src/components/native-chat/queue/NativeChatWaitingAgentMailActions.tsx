import { createContext, useContext } from 'react'
import { CornerDownRight, Send, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatPendingIcon } from './NativeChatPendingIcon'
import { queuedMessageCardSendNow } from './NativeChatQueuedMessageCard'
import type { StructuredAgentSessionQueuedMessagesController } from './use-structured-agent-session-queued-messages'

type WaitingAgentMailActions = Pick<
  StructuredAgentSessionQueuedMessagesController,
  'steer' | 'remove' | 'pending' | 'isWorking'
> & {
  /** The chat reads Stopping: nothing steers into the turn a Stop is ending. */
  steerHeld: boolean
}

/** The chat's queue actions, for other agents' mail the transcript draws while it waits. */
export const NativeChatWaitingAgentMailContext = createContext<WaitingAgentMailActions | null>(
  null
)

/** Steer (Send while idle) and Delete on a waiting agent message, as its queued card offered. */
export function NativeChatWaitingAgentMailActions({
  queuedMessageId
}: {
  queuedMessageId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const actions = useContext(NativeChatWaitingAgentMailContext)
  if (!actions) {
    return null
  }
  const pending = actions.pending(queuedMessageId)
  const busy = pending !== null
  const sendNow = queuedMessageCardSendNow({ hold: 'turn' }, actions.isWorking, t)
  const deleteLabel = t('components.native-chat.queuedMessages.delete', 'Delete')
  return (
    <span className="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={actions.steerHeld || busy}
            onClick={() => void actions.steer(queuedMessageId)}
          >
            <NativeChatPendingIcon pending={pending === 'send'} className="size-3">
              {sendNow.steers ? (
                <CornerDownRight className="size-3" />
              ) : (
                <Send className="size-3" />
              )}
            </NativeChatPendingIcon>
            {sendNow.label}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {sendNow.hint}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={deleteLabel}
            disabled={busy}
            onClick={() => void actions.remove(queuedMessageId)}
          >
            <NativeChatPendingIcon pending={pending === 'delete'} className="size-3.5">
              <Trash2 className="size-3.5" />
            </NativeChatPendingIcon>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {deleteLabel}
        </TooltipContent>
      </Tooltip>
    </span>
  )
}
