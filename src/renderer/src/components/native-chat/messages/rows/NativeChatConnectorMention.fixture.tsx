import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { connectorAskerPrompt } from '../../../../../../shared/connector-asker-prompt'
import { storedConnectorAsker } from '../../../../../../shared/connector-message-asker'
import type { ConnectorAsker } from '../../../../../../shared/connectors/connector-cloud-contract'
import type { ConnectorSource } from '../../../../../../shared/connectors/external-conversation-link'
import { projectStructuredItemToNativeChat } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { MessageRow } from './NativeChatMessageRow'

const asker: ConnectorAsker = {
  userId: 'ou_authorised',
  name: 'Dana',
  role: 'member',
  place: { kind: 'channel', id: 'oc_reviews' },
  text: 'Review the deployment',
  context: []
}

function Mention({ source, answered }: { source: ConnectorSource; answered: boolean }) {
  const message = projectStructuredItemToNativeChat({
    itemId: 'mention',
    sequence: 1,
    revision: 0,
    observedAt: 1794916800000,
    body: {
      kind: 'message',
      role: 'user',
      origin: 'connector',
      asker: storedConnectorAsker(source, asker),
      blocks: [{ type: 'text', text: connectorAskerPrompt(source, asker) }]
    }
  })
  const reply = projectStructuredItemToNativeChat({
    itemId: 'reply',
    sequence: 2,
    revision: 0,
    observedAt: 1794916800000,
    body: {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Deployment reviewed.' }]
    }
  })
  return (
    <div className="native-chat-appearance p-4">
      {message ? (
        <MessageRow message={message} expandSignal={false} onScrollMessageToTop={() => {}} />
      ) : null}
      {answered && reply ? (
        <MessageRow message={reply} expandSignal={false} onScrollMessageToTop={() => {}} />
      ) : null}
    </div>
  )
}

const fixture = (source: ConnectorSource, answered: boolean) =>
  defineFixture({ width: 640, render: () => <Mention source={source} answered={answered} /> })

export const feishuBeforeReply = fixture('feishu', false)
export const feishuAfterReply = fixture('feishu', true)
export const larkBeforeReply = fixture('lark', false)
export const larkAfterReply = fixture('lark', true)
export const slackBeforeReply = fixture('slack', false)
export const slackAfterReply = fixture('slack', true)
