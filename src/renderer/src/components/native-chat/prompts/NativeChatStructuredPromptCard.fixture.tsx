import { useRef } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { targetBotLinkItem, useBotLinkPrompt } from '@/lib/agent-session/open/bot-link-item-target'
import type { StructuredPromptItem } from '../../../../../shared/agent-session/view/structured-agent-session-message-projection'
import { NativeChatStructuredPromptCard } from './NativeChatStructuredPromptCard'
import { nativeChatAppearanceStyle } from '../appearance/native-chat-appearance-style'

const prompts: StructuredPromptItem[] = [
  'Which branch should I use?',
  'Which layout should ship?'
].map((question, index) => ({
  itemId: `question-${index + 1}`,
  revision: 0,
  sequence: index + 1,
  observedAt: 1,
  body: {
    kind: 'question',
    question,
    options: [
      { id: 'compact', label: 'Compact' },
      { id: 'roomy', label: 'Roomy' }
    ],
    resolution: { state: 'pending', selectedOptionId: null, resolvedAt: null, resolvedBy: null }
  }
}))

function LinkedQuestion() {
  const prompt = useBotLinkPrompt('seeded-session', prompts)
  const input = useRef<HTMLTextAreaElement>(null)
  return (
    <div
      className="native-chat-appearance bg-chat-canvas p-4"
      style={nativeChatAppearanceStyle({})}
    >
      <NativeChatStructuredPromptCard
        prompt={prompt}
        promptResponse={{ holds: () => false, respond: async () => null }}
        onCancel={() => {}}
        shouldFocus={false}
        answerInputRef={input}
      />
    </div>
  )
}

export const before = defineFixture({
  width: 560,
  setup: () => targetBotLinkItem('seeded-session'),
  render: () => <LinkedQuestion />
})
export const linked = defineFixture({
  width: 560,
  setup: () => targetBotLinkItem('seeded-session', 'question-2'),
  render: () => <LinkedQuestion />
})
