import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatMessageList } from '../../NativeChatMessageList'
import type { NativeChatLiveSession } from '../../session/terminal/read/native-chat-live-session-contract'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'

let timestamp = 1_800_000_000_000
function at(): number {
  timestamp += 1_000
  return timestamp
}

function text(id: string, role: NativeChatMessage['role'], body: string): NativeChatMessage {
  return { id, role, source: 'transcript', timestamp: at(), blocks: [{ type: 'text', text: body }] }
}

const session: NativeChatLiveSession = {
  agent: 'codex',
  sessionId: 'prose-history-fixture',
  status: 'ready',
  readPhase: 'ready',
  hasMore: false,
  loadingEarlier: false,
  olderHistoryGeneration: 0,
  loadEarlier: async () => 'applied',
  messages: [
    text('prompt', 'user', 'Review the configuration.'),
    text('preamble', 'assistant', 'I will inspect the configuration and run the checks.'),
    text('reasoning', 'reasoning', 'Compare the configuration with the expected schema.'),
    {
      id: 'tool',
      role: 'assistant',
      source: 'transcript',
      timestamp: at(),
      blocks: [
        { type: 'tool-call', name: 'Bash', state: 'completed', input: { command: 'check-config' } },
        { type: 'tool-result', output: 'Configuration checks passed.' }
      ]
    },
    text('report', 'assistant', 'The configuration matches the schema. All checks passed.'),
    text('result', 'assistant', 'The review is complete. No changes are needed.'),
    text('follow-up', 'user', 'What did you check?'),
    text('reply', 'assistant', 'I checked required fields and the deployment defaults.')
  ]
}

function Transcript({ working = false }: { working?: boolean }): React.JSX.Element {
  return (
    <div className="flex h-[640px] flex-col">
      <NativeChatMessageList
        session={session}
        isWorking={working}
        expandSignal={false}
        settledTurns={
          working
            ? undefined
            : new Map([
                ['prompt', { startedAt: 0, workedSeconds: 12 }],
                ['follow-up', { startedAt: 13_000, workedSeconds: 3 }]
              ])
        }
      />
    </div>
  )
}

export const settled = defineFixture({ width: 640, render: () => <Transcript /> })
export const live = defineFixture({ width: 640, render: () => <Transcript working /> })
export const expanded = defineFixture({
  width: 640,
  render: () => <Transcript />,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click()
  }
})
