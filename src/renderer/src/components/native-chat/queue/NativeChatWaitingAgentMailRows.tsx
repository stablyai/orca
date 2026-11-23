import { memo, useContext } from 'react'
import { NativeChatAgentMessageCard } from '../messages/rows/NativeChatAgentMessageCard'
import { NativeChatWaitingAgentMailRowsContext } from './NativeChatWaitingAgentMailActions'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'

const NO_REFOLD = (): void => {}

/** Other agents' waiting mail, after the conversation's live activity: it is not part of the turn.
 *  Memoized with no props, so a streaming update redraws it only when the mail or its actions change. */
export const NativeChatWaitingAgentMailRows = memo(
  function NativeChatWaitingAgentMailRows(): React.JSX.Element | null {
    const rows = useContext(NativeChatWaitingAgentMailRowsContext)
    if (!rows || rows.length === 0) {
      return null
    }
    return (
      <>
        {rows.map((message) => (
          <NativeChatWaitingAgentMailRow key={message.id} message={message} />
        ))}
      </>
    )
  }
)

/** One waiting row, kept as is while its message is unchanged, so a new arrival draws only itself. */
const NativeChatWaitingAgentMailRow = memo(function NativeChatWaitingAgentMailRow({
  message
}: {
  message: NativeChatMessage
}): React.JSX.Element | null {
  if (!message.from) {
    return null
  }
  return (
    <div data-native-chat-message-id={message.id}>
      <NativeChatAgentMessageCard message={message} from={message.from} onRefolded={NO_REFOLD} />
    </div>
  )
})
