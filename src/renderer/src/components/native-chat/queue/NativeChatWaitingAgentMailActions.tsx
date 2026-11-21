import { createContext, useContext } from 'react'
import { CornerDownRight, Pencil, Send, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { NativeChatPendingIcon } from './NativeChatPendingIcon'
import { queuedMessageCardSendNow } from './NativeChatQueuedMessageCard'
import type { StructuredAgentSessionQueuedMessagesController } from './use-structured-agent-session-queued-messages'

/** Other agents' waiting mail and what a person can do with it before the agent takes it. */
export type NativeChatWaitingAgentMail = Pick<
  StructuredAgentSessionQueuedMessagesController,
  'steer' | 'remove' | 'pending' | 'isWorking' | 'stopping' | 'edit'
> & {
  rows: readonly NativeChatMessage[]
  /** Whether a row offers Edit, which opens it in the queue's editor above the composer. */
  editable: (messageId: string) => boolean
}

export const NativeChatWaitingAgentMailContext = createContext<NativeChatWaitingAgentMail | null>(
  null
)

/** Steer (Send while idle), Edit and Delete on a waiting agent message, as its queued card offered. */
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
  const editLabel = t('components.native-chat.queuedMessages.editMessage', 'Edit message')
  const deleteLabel = t('components.native-chat.queuedMessages.delete', 'Delete')
  return (
    <span className="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={actions.stopping || busy}
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
      {actions.editable(queuedMessageId) ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={editLabel}
              disabled={busy}
              onClick={() => void actions.edit(queuedMessageId)}
            >
              <Pencil className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {editLabel}
          </TooltipContent>
        </Tooltip>
      ) : null}
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
