import { createContext, useContext, useRef, useSyncExternalStore } from 'react'
import {
  createMembershipStore,
  type MembershipStore
} from '../../../../../shared/collections/membership-store'
import { CornerDownRight, Pencil, Send, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { NativeChatPendingIcon } from './NativeChatPendingIcon'
import { queuedMessageCardSendNow } from './NativeChatQueuedMessageCard'
import { refocusAfterQueueAction } from './native-chat-queue-refocus'
import { QUEUED_ROW_TARGET } from './NativeChatQueuedMessageRowTools'
import type { StructuredAgentSessionQueuedMessagesController } from './use-structured-agent-session-queued-messages'

/** Other agents' waiting mail and what a person can do with it before the agent takes it. */
export type NativeChatWaitingAgentMail = Pick<
  StructuredAgentSessionQueuedMessagesController,
  'steer' | 'remove' | 'pending' | 'isWorking' | 'edit'
> & {
  /** Stopping, or the host can't take a send now: Steer is greyed, as on the queue's cards. */
  steerHeld: boolean
  /** Which rows offer Edit, which opens one in the queue's editor above the composer. */
  editable: MembershipStore
  focusComposer?: () => void
}

export const NativeChatWaitingAgentMailContext = createContext<NativeChatWaitingAgentMail | null>(
  null
)

/** The waiting mail itself, apart from its actions, so a new arrival redraws no other row's buttons. */
export const NativeChatWaitingAgentMailRowsContext = createContext<
  readonly NativeChatMessage[] | null
>(null)

const NOT_EDITABLE: MembershipStore = createMembershipStore(() => false)

/** Steer (Send while idle), Edit and Delete on a waiting agent message, as its queued card offered. */
export function NativeChatWaitingAgentMailActions({
  queuedMessageId
}: {
  queuedMessageId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const actions = useContext(NativeChatWaitingAgentMailContext)
  const ref = useRef<HTMLSpanElement>(null)
  const store = actions?.editable ?? NOT_EDITABLE
  const readEditable = (): boolean => store.has(queuedMessageId)
  const editable = useSyncExternalStore(store.subscribe, readEditable, readEditable)
  if (!actions) {
    return null
  }
  // Sending or deleting removes this row and the focused button with it.
  const refocusAfter = (action: Promise<unknown>): void =>
    refocusAfterQueueAction(action, ref.current, actions.focusComposer)
  const pending = actions.pending(queuedMessageId)
  const busy = pending !== null
  const sendNow = queuedMessageCardSendNow({ hold: 'turn' }, actions.isWorking, t)
  const editLabel = t('components.native-chat.queuedMessages.editMessage', 'Edit message')
  const deleteLabel = t('components.native-chat.queuedMessages.delete', 'Delete')
  return (
    // No gap, as on a queued card's tool row: the buttons' own padding spaces their glyphs evenly, and
    // each keeps the row's 24px target floor so flush neighbors stay full size at any text size.
    <span ref={ref} className="flex items-center">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className={QUEUED_ROW_TARGET}
            disabled={actions.steerHeld || busy}
            onClick={() => refocusAfter(actions.steer(queuedMessageId))}
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
      {editable ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={QUEUED_ROW_TARGET}
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
            className={QUEUED_ROW_TARGET}
            aria-label={deleteLabel}
            disabled={busy}
            onClick={() => refocusAfter(actions.remove(queuedMessageId))}
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
