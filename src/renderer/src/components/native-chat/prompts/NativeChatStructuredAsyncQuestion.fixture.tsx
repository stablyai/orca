import { defineFixture } from '../../../component-fixtures/component-fixture'
import { stubAwaitedQuestion } from '../../../component-fixtures/awaited-question-stubs'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { nativeChatStructuredQuestions } from './NativeChatStructuredAsyncQuestion'
import { newestOpenStructuredAgentSessionAsyncQuestion } from '../../../../../shared/agent-session/view/structured-agent-session-async-questions'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'

const NOTICE: NativeChatMessage = {
  id: 'notice',
  role: 'user',
  from: { kind: 'agent', senders: [], orchestration: null },
  timestamp: 0,
  source: 'transcript',
  blocks: [{ type: 'text', text: 'Update from worker' }]
}

const QUESTION_ROW: AgentJournalRenderItem = {
  itemId: 'ask-row',
  revision: 1,
  sequence: 1,
  observedAt: 0,
  body: {
    kind: 'message',
    role: 'assistant',
    blocks: [
      {
        type: 'tool-call',
        name: 'request_user_input_async',
        callId: 'ask',
        input: {
          questions: [
            {
              title:
                'Should links from chat open in the app by default, or in your browser? The app keeps you signed in to the preview; the browser keeps your extensions and passwords.'
            },
            { title: 'If the app: should the setting live under Browser or under Chat?' }
          ]
        }
      }
    ]
  }
}

/** The question is older than the loaded messages: the card comes from the host's status. */
export const olderQuestion = defineFixture({
  width: 520,
  setup: () => {
    // The text as the host reads it from the question's row, so the card shows what it publishes.
    const asked = newestOpenStructuredAgentSessionAsyncQuestion([QUESTION_ROW], [])
    stubAwaitedQuestion('chat-older', 'ask-row', asked?.text ?? '')
  },
  render: () => (
    <div className="bg-background p-3">
      {nativeChatStructuredQuestions(
        // A hidden pane draws no session-link owner question, so only the async card shows.
        {
          target: { kind: 'local' },
          agent: 'codex',
          sessionId: 'chat-older',
          tabId: 'tab',
          isVisible: false,
          isFocusedGroup: false
        },
        { epoch: 'epoch', prompts: [], submissions: [] },
        { messages: [NOTICE], readPhase: 'ready' },
        { send: () => true },
        { queuedMessages: { cards: [] } }
      )}
    </div>
  )
})
