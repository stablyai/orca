import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { useAppStore } from '../../../../store/index'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { DEFAULT_BOT_AVATAR_COLOR } from '../../../../../../shared/bots/bot-avatar-color'
import { buildNativeChatTranscriptSlots } from '../../conversation/slots/native-chat-transcript-slots'
import { nativeChatSlotKey } from '../../conversation/slots/native-chat-transcript-slot-selection'
import { nativeChatTimeDividers } from '../../conversation/slots/native-chat-time-dividers'
import { NativeChatTranscriptRow } from './NativeChatTranscriptRow'
import { nativeChatAppearanceStyle } from '../../appearance/native-chat-appearance-style'

const start = Date.UTC(2026, 10, 26, 12, 20)
const messages: NativeChatMessage[] = [
  {
    id: 'ask',
    role: 'user',
    timestamp: start,
    source: 'transcript',
    blocks: [{ type: 'text', text: 'Check the afternoon forecast.' }]
  },
  {
    id: 'reply',
    role: 'assistant',
    timestamp: start + 20 * 60_000,
    source: 'transcript',
    blocks: [{ type: 'text', text: 'The afternoon looks clear. No rain is forecast.' }]
  }
]
const slots = buildNativeChatTranscriptSlots({
  messages,
  turnKeys: ['ask', 'ask'],
  liveTurnKey: undefined,
  receipts: new Map(),
  turnStatuses: { active: null, completedByTurn: {} },
  turnDiffs: new Map(),
  expandedTurnKeys: new Set(),
  isWorking: false,
  lifecycleWorking: false
})
const times = nativeChatTimeDividers(slots)
export const dividers = defineFixture({
  width: 640,
  setup: () => {
    const settings = useAppStore.getState().settings!
    useAppStore.setState({
      settings: { ...settings, nativeChatAppearance: { messageStyle: 'messaging' } }
    })
  },
  render: () => (
    <div
      className="native-chat-appearance flex flex-col gap-5 bg-chat-canvas p-4"
      style={nativeChatAppearanceStyle({
        theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light'
      })}
    >
      {slots.map((slot, index) => (
        <NativeChatTranscriptRow
          key={nativeChatSlotKey(slot)}
          slot={slot}
          timeDivider={times.get(index)}
          timeDividerBelow={times.has(index + 1)}
          newRowsMarker={
            index === 1
              ? {
                  key: 'reply',
                  place: 'above-row',
                  arriving: false,
                  onArrived: () => {},
                  onDismiss: () => {}
                }
              : undefined
          }
          context={{
            turnBot: { name: 'Scout', src: null, fallback: 'S', color: DEFAULT_BOT_AVATAR_COLOR },
            expandSignal: false,
            revealedDiff: null,
            taskListPredecessors: new Map(),
            expandedTurnIds: new Set(),
            onToggleExpandedTurn: () => {},
            onScrollMessageToTop: () => {},
            readerAtEnd: () => false,
            onRevealDiff: () => {}
          }}
        />
      ))}
    </div>
  )
})
