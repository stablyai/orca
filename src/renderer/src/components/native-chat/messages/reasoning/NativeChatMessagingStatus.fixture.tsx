import { useAppStore } from '../../../../store/index'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { buildNativeChatTranscriptSlots } from '../../conversation/slots/native-chat-transcript-slots'
import { NativeChatTranscriptRowStack } from '../../viewport/virtualization/NativeChatTranscriptItems'
import { NativeChatTranscriptTail } from '../../conversation/turns/NativeChatTranscriptTail'
import { useState } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatTurnActivityLine } from './NativeChatTurnActivityLine'
import { nativeChatAppearanceStyle } from '../../appearance/native-chat-appearance-style'

export const reading = defineFixture({
  width: 640,
  render: () => (
    <div
      className="native-chat-appearance bg-chat-canvas p-4"
      style={nativeChatAppearanceStyle({
        theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light'
      })}
    >
      <NativeChatTurnActivityLine
        messaging
        line={{
          thinking: false,
          stopping: false,
          activityText: 'Reading the PDF',
          reasoning: null
        }}
      />
    </div>
  )
})

function ChangingStatus({ visible = true }: { visible?: boolean }) {
  const [activity, setActivity] = useState('Reading the PDF')
  return (
    <div
      className="native-chat-appearance bg-chat-canvas p-4"
      style={nativeChatAppearanceStyle({
        theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light'
      })}
    >
      <button
        type="button"
        className="sr-only"
        data-change-activity
        onClick={() => setActivity('Checking your calendar')}
      >
        Change activity
      </button>
      <NativeChatTurnActivityLine
        messaging
        visible={visible}
        line={{ thinking: false, stopping: false, activityText: activity, reasoning: null }}
      />
    </div>
  )
}
export const changing = defineFixture({ width: 640, render: () => <ChangingStatus /> })
export const hidden = defineFixture({
  width: 640,
  render: () => <ChangingStatus visible={false} />
})

function TranscriptStatus({ reply = false }: { reply?: boolean }) {
  const messages: NativeChatMessage[] = [
    {
      id: 'ask',
      role: 'user',
      timestamp: 1,
      source: 'transcript',
      blocks: [{ type: 'text', text: 'Check the PDF for my meeting.' }]
    }
  ]
  if (reply) {
    messages.push({
      id: 'answer',
      role: 'assistant',
      timestamp: 2,
      source: 'transcript',
      blocks: [{ type: 'text', text: 'Your meeting is tomorrow at 9:00.' }]
    })
  }
  const slots = buildNativeChatTranscriptSlots({
    messages,
    turnKeys: messages.map(() => 'ask'),
    liveTurnKey: 'ask',
    receipts: new Map(),
    turnStatuses: {
      active: { startedAt: 1, workedSeconds: null, thinking: false },
      completedByTurn: {}
    },
    turnDiffs: new Map(),
    expandedTurnKeys: new Set(),
    isWorking: true,
    lifecycleWorking: true
  })
  const context = {
    turnBot: { name: 'Scout', src: null, fallback: 'S' },
    expandSignal: false,
    revealedDiff: null,
    taskListPredecessors: new Map(),
    expandedTurnIds: new Set<string>(),
    onToggleExpandedTurn: () => {},
    onScrollMessageToTop: () => {},
    readerAtEnd: () => true,
    onRevealDiff: () => {}
  }
  return (
    <div
      className="native-chat-appearance flex flex-col gap-5 bg-chat-canvas p-4"
      style={nativeChatAppearanceStyle({
        theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light'
      })}
    >
      <NativeChatTranscriptRowStack slots={slots} context={context} />
      <NativeChatTranscriptTail
        slots={slots}
        context={context}
        line={{
          thinking: false,
          stopping: false,
          activityText: 'Reading the PDF',
          reasoning: null
        }}
        awaitingInput={false}
        visible
      />
    </div>
  )
}
function messagingSetup() {
  const settings = useAppStore.getState().settings!
  useAppStore.setState({
    settings: { ...settings, nativeChatAppearance: { messageStyle: 'messaging' } }
  })
}
export const beforeReply = defineFixture({
  width: 640,
  setup: messagingSetup,
  render: () => <TranscriptStatus />
})
export const replying = defineFixture({
  width: 640,
  setup: messagingSetup,
  render: () => <TranscriptStatus reply />
})
