import { defineFixture } from '../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../shared/constants'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { MessageRow } from './NativeChatMessageRow'
import { buildNativeChatTranscriptSlots } from './native-chat-transcript-slots'

const reviewText =
  'Automatic approval review approved (risk: low, authorization: high): The local check is allowed.'
const review: NativeChatMessage = {
  id: 'approved-review',
  role: 'system',
  source: 'transcript',
  timestamp: 1,
  blocks: [
    {
      type: 'text',
      text: reviewText,
      tone: 'warning',
      providerFrame: {
        provider: 'codex',
        kind: 'notification:guardianWarning',
        payload: {
          head: JSON.stringify({ message: reviewText }),
          byteLength: reviewText.length,
          digest: 'fixture-review',
          truncated: false
        }
      }
    }
  ]
}
const command: NativeChatMessage = {
  id: 'check',
  role: 'assistant',
  source: 'transcript',
  timestamp: 2,
  blocks: [
    {
      type: 'tool-call',
      callId: 'check',
      name: 'Bash',
      input: { command: 'pnpm test' },
      state: 'completed'
    },
    { type: 'tool-result', callId: 'check', output: 'All targeted checks passed.' }
  ]
}
const prose: NativeChatMessage = {
  id: 'summary',
  role: 'assistant',
  source: 'transcript',
  timestamp: 3,
  blocks: [
    {
      type: 'text',
      text: 'The local checks passed. The original review remains available in Activity.'
    }
  ]
}
function transcript() {
  const messages = [review, command, prose]
  const slots = buildNativeChatTranscriptSlots({
    messages,
    turnKeys: messages.map(() => 'turn'),
    liveTurnKey: undefined,
    receipts: new Map(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map(),
    expandedTurnKeys: new Set(),
    isWorking: false,
    lifecycleWorking: false
  })
  return (
    <div className="native-chat-appearance space-y-4 p-4">
      {slots.map((slot) =>
        slot.kind === 'message' ? (
          <MessageRow
            key={slot.message.id}
            message={slot.message}
            workRun={slot.workRun}
            expandSignal={false}
            activeTurnIsWorking={false}
            onScrollMessageToTop={() => {}}
          />
        ) : null
      )}
    </div>
  )
}
const store = { settings: { ...getDefaultSettings('/home/fixture'), uiLanguage: 'en' as const } }

export const collapsed = defineFixture({ store, width: 760, render: transcript })
export const expanded = defineFixture({
  store,
  width: 760,
  render: transcript,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('[data-native-chat-tool-run-state]')?.click()
  }
})
