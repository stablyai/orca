import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatTurnDiffRollup } from './NativeChatTurnDiffRollup'
import { NativeChatMessageList } from './NativeChatMessageList'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { nativeChatTurnDiffs } from '../../../../shared/native-chat/tools/native-chat-turn-diffs'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'

const messages: NativeChatMessage[] = [
  {
    id: 'user',
    role: 'user',
    source: 'transcript',
    timestamp: 0,
    blocks: [{ type: 'text', text: 'Update the greeting and mark the feature ready.' }]
  },
  {
    id: 'edits',
    role: 'assistant',
    source: 'transcript',
    timestamp: 1,
    blocks: [
      {
        type: 'tool-call',
        name: 'Bash',
        state: 'completed',
        input: { command: 'inspect sources' }
      },
      { type: 'tool-result', output: 'Source files inspected.' },
      {
        type: 'tool-call',
        name: 'Edit',
        state: 'completed',
        input: {
          file_path: '/Users/alice/orca/workspaces/orca/feature-x/src/components/greeting.ts',
          old_string: 'return "Hello"',
          new_string: 'return `Hello, ${name}`'
        }
      },
      { type: 'tool-result', output: 'The file was updated successfully.' },
      { type: 'tool-call', name: 'Diff', input: { path: 'src/components/status.ts' } },
      {
        type: 'tool-result',
        output: '@@ -1 +1 @@\n-export const ready = false\n+export const ready = true'
      }
    ]
  },
  {
    id: 'answer',
    role: 'assistant',
    source: 'transcript',
    timestamp: 2,
    blocks: [
      { type: 'text', text: 'The greeting now includes the name, and the feature is ready.' }
    ]
  }
]
const diff = nativeChatTurnDiffs(
  messages,
  messages.map(() => 'turn')
).get('turn')!
export const settled = defineFixture({
  width: 560,
  render: () => <NativeChatTurnDiffRollup diff={diff} />
})
export const opened = defineFixture({
  width: 560,
  render: () => <NativeChatTurnDiffRollup diff={diff} />,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button')?.click()
  }
})

const session: NativeChatLiveSession = {
  messages,
  agent: 'claude',
  sessionId: 'fixture',
  status: 'ready',
  readPhase: 'ready',
  hasMore: false,
  loadingEarlier: false,
  olderHistoryGeneration: 0,
  loadEarlier: async () => 'applied'
}
function Transcript({ working = false }: { working?: boolean }) {
  return (
    <div className="flex h-[600px] flex-col">
      <NativeChatMessageList
        session={session}
        isWorking={working}
        expandSignal={false}
        settledTurns={working ? undefined : new Map([['user', { startedAt: 0, workedSeconds: 2 }]])}
      />
    </div>
  )
}
export const completedTranscript = defineFixture({ width: 560, render: () => <Transcript /> })
export const completedTranscriptOpened = defineFixture({
  width: 560,
  render: () => <Transcript />,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button[title$="greeting.ts"]')?.click()
  }
})
export const liveTranscript = defineFixture({ width: 560, render: () => <Transcript working /> })
