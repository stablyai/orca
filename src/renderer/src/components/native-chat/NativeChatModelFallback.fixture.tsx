import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'
import { ProviderFrameRow } from './NativeChatTranscriptChrome'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { MessageRow } from './NativeChatMessageRow'
import { projectStructuredItemToNativeChat } from '../../../../shared/agent-session/view/structured-agent-session-projection'

const head = JSON.stringify({
  type: 'fallback',
  from: { model: 'claude-opus-5-5' },
  to: { model: 'claude-opus-4-8' }
})
const raw = {
  text: 'Claude sent content Orca cannot display yet',
  providerFrame: {
    provider: 'claude',
    kind: 'message:assistant:content:fallback',
    payload: { head, byteLength: head.length, digest: 'fixture', truncated: false }
  }
}
const message = projectStructuredItemToNativeChat({
  itemId: 'fallback',
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: { kind: 'status', ...raw }
})

function ModelPicker({ reportedModel }: { reportedModel?: string }) {
  return (
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
          reportedModel,
          kind: {
            type: 'select',
            currentValue: 'claude-opus-5-5',
            choices: [{ value: 'claude-opus-5-5', label: 'Opus 5.5' }]
          }
        }
      ]}
    />
  )
}

function FallbackNotice() {
  return message ? (
    <MessageRow
      message={message}
      agentName="Claude"
      expandSignal={false}
      onScrollMessageToTop={() => {}}
    />
  ) : null
}

export const fallback = defineFixture({
  width: 720,
  render: () => (
    <div className="native-chat-appearance p-4">
      <FallbackNotice />
    </div>
  )
})

export const narrow = defineFixture({ width: 320, render: fallback.render })

export const composer = defineFixture({
  width: 360,
  render: () => (
    <div className="native-chat-appearance p-4">
      <ModelPicker reportedModel="claude-opus-4-8" />
    </div>
  )
})

export const before = defineFixture({
  width: 720,
  render: () => (
    <div className="native-chat-appearance space-y-4 p-4">
      <ProviderFrameRow block={{ type: 'text', ...raw }} />
      <ModelPicker />
    </div>
  ),
  interact: (frame) => {
    frame.querySelector('summary')?.click()
  }
})

export const after = defineFixture({
  width: 720,
  render: () => (
    <div className="native-chat-appearance space-y-4 p-4">
      <FallbackNotice />
      <ModelPicker reportedModel="claude-opus-4-8" />
    </div>
  )
})
