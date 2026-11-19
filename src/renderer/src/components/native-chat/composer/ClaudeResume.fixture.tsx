import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { NativeChatComposer } from './NativeChatComposer'

const messages: NativeChatMessage[] = [
  {
    id: 'sample-reply',
    role: 'assistant',
    source: 'transcript',
    timestamp: 1,
    blocks: [{ type: 'text', text: 'Hello.' }],
    model: 'claude-sonnet-4-5',
    effort: 'medium'
  }
]

export const afterReopen = defineFixture({
  width: 780,
  render: () => (
    <div className="native-chat-appearance bg-background p-4">
      <NativeChatComposer
        paneKey="sample-tab:sample-pane"
        terminalTabId="sample-tab"
        targetPtyId="sample-pty"
        agent="claude"
        readTerminalScreen={() => ''}
        recallSource={{ messages }}
      />
    </div>
  )
})
