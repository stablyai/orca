import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { MessageRow } from './NativeChatMessageRow'
import { projectStructuredItemToNativeChat } from '../../../../shared/agent-session/view/structured-agent-session-projection'

const head = JSON.stringify({
  type: 'fallback',
  from: { model: 'claude-opus-5-5' },
  to: { model: 'claude-opus-4-8' }
})
const message = projectStructuredItemToNativeChat({
  itemId: 'fallback',
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: {
    kind: 'status',
    text: 'Claude sent content Orca cannot display yet',
    providerFrame: {
      provider: 'claude',
      kind: 'message:assistant:content:fallback',
      payload: { head, byteLength: head.length, digest: 'fixture', truncated: false }
    }
  }
})

export const fallback = defineFixture({
  width: 720,
  render: () =>
    message ? (
      <div className="native-chat-appearance p-4">
        <MessageRow
          message={message}
          agentName="Claude"
          expandSignal={false}
          onScrollMessageToTop={() => {}}
        />
      </div>
    ) : null
})

export const narrow = defineFixture({
  width: 320,
  render: fallback.render
})

export const composer = defineFixture({
  width: 360,
  render: () => (
    <div className="native-chat-appearance p-4">
      <NativeChatSessionOptionPickers
        surface={{
          getSnapshot: () => [],
          subscribe: () => () => {},
          setOption: async () => ({ snapshot: [] }),
          invokeAction: async () => ({ snapshot: [] })
        }}
        isWorking={true}
        snapshot={[
          {
            id: 'model',
            label: 'Model',
            category: 'model',
            transport: 'agent-session',
            settable: false,
            valueSource: 'applied',
            reportedModel: 'claude-opus-4-8',
            kind: {
              type: 'select',
              currentValue: 'claude-opus-5-5',
              choices: [{ value: 'claude-opus-5-5', label: 'Opus 5.5' }]
            }
          }
        ]}
      />
    </div>
  )
})
