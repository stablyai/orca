import { memo, useContext } from 'react'
import { NativeChatAgentMessageCard } from '../messages/rows/NativeChatAgentMessageCard'
import { NativeChatWaitingAgentMailContext } from './NativeChatWaitingAgentMailActions'

const NO_REFOLD = (): void => {}

/** Other agents' waiting mail, after the conversation's live activity: it is not part of the turn.
 *  Memoized with no props, so a streaming update redraws it only when the mail or its actions change. */
export const NativeChatWaitingAgentMailRows = memo(
  function NativeChatWaitingAgentMailRows(): React.JSX.Element | null {
    const mail = useContext(NativeChatWaitingAgentMailContext)
    if (!mail || mail.rows.length === 0) {
      return null
    }
    return (
      <>
        {mail.rows.map((message) =>
          message.from ? (
            <div key={message.id} data-native-chat-message-id={message.id}>
              <NativeChatAgentMessageCard
                message={message}
                from={message.from}
                onRefolded={NO_REFOLD}
              />
            </div>
          ) : null
        )}
      </>
    )
  }
)
