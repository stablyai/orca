import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import { NativeChatSessionOptionPickers } from '../controls/NativeChatSessionOptionPickers'
import { useNativeChatSessionOptions } from './use-native-chat-session-options'

const transcriptMessages: NativeChatMessage[] = [
  {
    id: 'response',
    role: 'assistant',
    source: 'transcript',
    timestamp: null,
    blocks: [{ type: 'text', text: 'Finished the change.' }],
    model: 'claude-opus-5-5'
  }
]
const dispatchCommand = async (): Promise<void> => {}

function ModelPicker({ messages }: { messages?: readonly NativeChatMessage[] }) {
  const options = useNativeChatSessionOptions({
    agent: 'claude',
    terminalTabId: 'fixture-terminal-model',
    targetPtyId: 'fixture-terminal-model-pty',
    dispatchCommand,
    transcriptMessages: messages
  })
  return (
    <div className="native-chat-appearance bg-background p-4">
      <NativeChatSessionOptionPickers
        surface={options.surface}
        snapshot={options.snapshot}
        isWorking={false}
      />
    </div>
  )
}

export const before = defineFixture({ width: 360, render: () => <ModelPicker /> })
export const after = defineFixture({
  width: 360,
  render: () => <ModelPicker messages={transcriptMessages} />
})
