import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { useAppStore } from '../../../../store/index'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { buildNativeChatTranscriptSlots } from '../../conversation/slots/native-chat-transcript-slots'
import { NativeChatTranscriptRowStack } from '../../viewport/virtualization/NativeChatTranscriptItems'
import { nativeChatAppearanceStyle } from '../../appearance/native-chat-appearance-style'

const conversation: Pick<NativeChatMessage, 'id' | 'role' | 'blocks'>[] = [
  { id: 'ask', role: 'user', blocks: [{ type: 'text', text: 'Can you help plan tomorrow?' }] },
  { id: 'detail', role: 'user', blocks: [{ type: 'text', text: 'Keep the afternoon free.' }] },
  {
    id: 'reply',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'Of course. I’ll check your calendar first.' }]
  },
  {
    id: 'check',
    role: 'assistant',
    blocks: [
      {
        type: 'tool-call',
        name: 'read_file',
        callId: 'calendar',
        input: { path: 'calendar.md' },
        state: 'completed'
      },
      { type: 'tool-result', callId: 'calendar', output: '09:00 Planning\n10:30 Design review' }
    ]
  },
  {
    id: 'plan',
    role: 'assistant',
    blocks: [
      {
        type: 'text',
        text: '**Tomorrow morning**\n\n- 9:00 — Planning\n- 10:30 — Design review\n\nYour afternoon is free.'
      }
    ]
  },
  {
    id: 'followup',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'Would you like a reminder before the review?' }]
  },
  {
    id: 'thanks',
    role: 'user',
    blocks: [{ type: 'text', text: 'Yes, ten minutes before. Thanks!' }]
  }
]

const messages: NativeChatMessage[] = conversation.map((message, index) => ({
  ...message,
  source: 'transcript',
  timestamp: Date.UTC(2026, 10, 20, 9, index)
}))

const slots = buildNativeChatTranscriptSlots({
  messages,
  turnKeys: ['ask', 'detail', 'detail', 'detail', 'detail', 'detail', 'thanks'],
  liveTurnKey: undefined,
  turnStatuses: { active: null, completedByTurn: {} },
  receipts: new Map(),
  turnDiffs: new Map(),
  expandedTurnKeys: new Set(),
  isWorking: false,
  lifecycleWorking: false
})

function Conversation() {
  const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  return (
    <div
      className="native-chat-appearance bg-chat-canvas p-4"
      style={nativeChatAppearanceStyle({ theme })}
    >
      <NativeChatTranscriptRowStack
        slots={slots}
        context={{
          expandSignal: false,
          revealedDiff: null,
          taskListPredecessors: new Map(),
          expandedTurnIds: new Set(),
          onToggleExpandedTurn: () => {},
          onScrollMessageToTop: () => {},
          readerAtEnd: () => true,
          onRevealDiff: () => {}
        }}
      />
    </div>
  )
}

function setStyle(messageStyle: 'default' | 'messaging') {
  const settings = useAppStore.getState().settings!
  useAppStore.setState({ settings: { ...settings, nativeChatAppearance: { messageStyle } } })
}

export const before = defineFixture({
  width: 640,
  setup: () => setStyle('default'),
  render: () => <Conversation />
})
export const messaging = defineFixture({
  width: 640,
  setup: () => setStyle('messaging'),
  render: () => <Conversation />
})
export const narrow = defineFixture({
  width: 360,
  setup: () => setStyle('messaging'),
  render: () => <Conversation />
})
export const expanded = defineFixture({
  width: 640,
  setup: () => setStyle('messaging'),
  render: () => <Conversation />,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click()
  }
})
