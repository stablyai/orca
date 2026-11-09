import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { withSenderEnvelope } from '../../../../shared/cloud-workspaces/sender-envelope'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatUserMessageRow } from '../native-chat/messages/rows/NativeChatUserMessageRow'

function userRow(id: string, text: string): React.JSX.Element {
  const message: NativeChatMessage = {
    id,
    role: 'user',
    source: 'transcript',
    blocks: [{ type: 'text', text }],
    timestamp: Date.now() - 60_000
  }
  return (
    <NativeChatUserMessageRow
      message={message}
      markdown={text}
      prose={message.blocks}
      rowRef={{ current: null }}
      onRefolded={() => {}}
    />
  )
}

/** In a shared cloud workspace, a teammate's message shows "From {name}" and never the raw line. */
export const senderChip = defineFixture({
  width: 640,
  render: () => (
    <div className="space-y-4 p-4">
      {userRow(
        'from-grace',
        withSenderEnvelope('Can you retry the refund webhook with the new signing key?', {
          userId: 'user_grace',
          name: 'Grace Hopper'
        })
      )}
      {userRow('plain', 'A message with no sender line (local or private workspace).')}
    </div>
  )
})
