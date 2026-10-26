import { defineFixture } from '../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../shared/constants'
import { NativeChatVoiceLayout } from './NativeChatVoiceLayout'
import { NativeChatMessageList } from './NativeChatMessageList'
import type { NativeChatLiveSession } from './use-native-chat-live-session'

const session: NativeChatLiveSession = {
  sessionId: 'voice-history-fixture',
  agent: 'codex',
  status: 'ready',
  readPhase: 'ready',
  hasMore: false,
  loadingEarlier: false,
  olderHistoryGeneration: 0,
  loadEarlier: async () => 'exhausted',
  messages: [
    {
      id: 'user-1',
      role: 'user',
      source: 'transcript',
      timestamp: 1,
      blocks: [{ type: 'text', text: 'Summarize the plan we discussed.' }]
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      source: 'transcript',
      timestamp: 2,
      blocks: [
        {
          type: 'text',
          text: 'First, review the existing implementation. Then add the requested behavior and run the relevant checks.'
        }
      ]
    },
    {
      id: 'user-2',
      role: 'user',
      source: 'transcript',
      timestamp: 3,
      blocks: [{ type: 'text', text: 'Can we keep talking while I read the history?' }]
    },
    {
      id: 'assistant-2',
      role: 'assistant',
      source: 'transcript',
      timestamp: 4,
      blocks: [
        {
          type: 'text',
          text: 'Yes. Switching to the conversation history keeps voice active. Return to the Voice tab to end the conversation.'
        }
      ]
    }
  ]
}

export const history = defineFixture({
  width: 360,
  store: { settings: { ...getDefaultSettings('/home/fixture'), uiLanguage: 'en' } },
  render: () => (
    <div className="native-chat-appearance flex h-160 flex-col bg-background text-chat-foreground">
      <NativeChatVoiceLayout
        history={<NativeChatMessageList session={session} isWorking={false} expandSignal={false} />}
      >
        <p className="p-3 text-sm">Voice conversation</p>
      </NativeChatVoiceLayout>
    </div>
  ),
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('[role="tab"][id$="-trigger-history"]')?.focus()
  }
})

export const narrow = defineFixture({ ...history, width: 280 })
