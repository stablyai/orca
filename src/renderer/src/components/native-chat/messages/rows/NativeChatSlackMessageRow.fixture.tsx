import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { connectorAskerPrompt } from '../../../../../../shared/connector-asker-prompt'
import { storedConnectorAsker } from '../../../../../../shared/connector-message-asker'
import type { ConnectorAsker } from '../../../../../../shared/connectors/connector-cloud-contract'
import { projectStructuredItemToNativeChat } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { MessageRow } from './NativeChatMessageRow'
import { NativeChatDisclosureContext } from '../disclosure/native-chat-disclosure-store'
import { NativeChatSlackPeopleContext } from '../../native-chat-markdown-mentions'

const ASKER: ConnectorAsker = {
  userId: 'U0SAM',
  name: 'Sam Lee',
  role: 'member',
  place: { kind: 'public_channel', id: 'C0ORCA' },
  text:
    '<@U0ANN|Ann Park> and <@U0BOB> can you check <https://github.com/stablyai/orca/pull/1|the release PR> ' +
    'before Friday? Posting in <#C0ORCA|p-orca> for <!subteam^S0QA|@qa-team>, <!here>. ' +
    'Due <!date^1763500000^{date_short}|Nov 18>. Typed: &lt;@U0X|not a mention&gt;',
  context: []
}

const EARLIER: ConnectorAsker = {
  ...ASKER,
  text: 'Can you pick this up?',
  context: [
    {
      kind: 'no_access',
      userId: 'U0ZED',
      name: 'Zed Ray',
      text: '<@U0ANN|Ann Park> the fix is in <#C0ORCA|p-orca>, see <https://github.com/stablyai/orca/pull/1|the release PR>'
    }
  ]
}

function SlackMessage({ asker = ASKER }: { asker?: ConnectorAsker }): React.JSX.Element {
  const message = projectStructuredItemToNativeChat({
    itemId: 'slack-message',
    sequence: 1,
    revision: 0,
    observedAt: 0,
    body: {
      kind: 'message',
      role: 'user',
      origin: 'connector',
      asker: storedConnectorAsker('slack', asker),
      blocks: [{ type: 'text', text: connectorAskerPrompt('slack', asker) }]
    }
  })
  return (
    <div className="native-chat-appearance p-4">
      {message ? (
        <MessageRow message={message} expandSignal={false} onScrollMessageToTop={() => {}} />
      ) : null}
    </div>
  )
}

export const slackMarkup = defineFixture({ width: 640, render: () => <SlackMessage /> })
// Every fold open, so the earlier messages show.
const OPEN = { read: () => true, write: () => {} }
export const slackEarlierMessages = defineFixture({
  width: 640,
  render: () => (
    <NativeChatDisclosureContext.Provider value={OPEN}>
      <SlackMessage asker={EARLIER} />
    </NativeChatDisclosureContext.Provider>
  )
})

function AgentReply(): React.JSX.Element {
  const message = projectStructuredItemToNativeChat({
    itemId: 'agent-reply',
    sequence: 2,
    revision: 0,
    observedAt: 0,
    body: {
      kind: 'message',
      role: 'assistant',
      blocks: [
        {
          type: 'text',
          text:
            '<@U0SAM> The limit of about 5 is per channel. <!here> ask <@U0ANN|Ann Park> or ' +
            '<@U0ZED>; the raw form stays in code: `<@U0SAM>`'
        }
      ]
    }
  })
  return (
    <NativeChatSlackPeopleContext value={new Map([['U0SAM', 'Sam Lee']])}>
      <div className="native-chat-appearance p-4">
        {message ? (
          <MessageRow message={message} expandSignal={false} onScrollMessageToTop={() => {}} />
        ) : null}
      </div>
    </NativeChatSlackPeopleContext>
  )
}

export const agentReplyMentions = defineFixture({ width: 640, render: () => <AgentReply /> })
