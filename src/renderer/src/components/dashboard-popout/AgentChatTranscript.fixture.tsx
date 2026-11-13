import { defineFixture } from '@/component-fixtures/component-fixture'
import { AgentChatTranscript } from './AgentChatTranscript'

export const conversation = defineFixture({
  width: 640,
  render: () => (
    <div className="flex h-96 flex-col bg-background">
      <AgentChatTranscript
        agentName="Claude"
        status="ready"
        current
        hasOlder
        loadingOlder={false}
        loadOlder={() => {}}
        messages={[
          {
            id: 'user',
            role: 'user',
            source: 'transcript',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'Review the restoration fix and explain the result.' }]
          },
          {
            id: 'assistant',
            role: 'assistant',
            source: 'transcript',
            timestamp: 2,
            blocks: [
              {
                type: 'text',
                text: 'The regression checks passed.\n\n- Existing sessions keep their runtime owner.\n- The preview reads the recorded conversation.\n\n```ts\nconst preview = { readOnly: true }\n```'
              }
            ]
          }
        ]}
      />
    </div>
  )
})
