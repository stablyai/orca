import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatMessageList } from '../../NativeChatMessageList'
import type { NativeChatLiveSession } from '../../session/terminal/read/native-chat-live-session-contract'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { orchestrationMailFixture } from '../../../../../../shared/agent-session/orchestration-mail.test-fixture'

const STARTED_AT = 1_800_000_000_000
let sent = 0
function at(): number {
  sent += 1
  return STARTED_AT + sent * 60_000
}
function text(id: string, role: NativeChatMessage['role'], body: string): NativeChatMessage {
  return { id, role, source: 'transcript', timestamp: at(), blocks: [{ type: 'text', text: body }] }
}

// What follows a response's copy / fork / scroll-up row: a worker's card, the person's own bubble,
// and the turn's changed-files rollup.
const messages: NativeChatMessage[] = [
  text('ask', 'user', 'Have a worker review the parser.'),
  text('dispatched', 'assistant', 'A review worker is on it. I will report when it answers.'),
  {
    ...orchestrationMailFixture({ body: 'The parser review found nothing blocking.' }),
    timestamp: at()
  },
  text('reported', 'assistant', 'The worker found nothing blocking.'),
  text('follow-up', 'user', 'Good. Update the greeting too.'),
  {
    id: 'edit',
    role: 'assistant',
    source: 'transcript',
    timestamp: at(),
    blocks: [
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
      { type: 'tool-result', output: 'The file was updated successfully.' }
    ]
  },
  text('answer', 'assistant', 'The greeting now includes the name.')
]

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

export const responseActionsGap = defineFixture({
  width: 560,
  render: () => (
    <div className="flex h-[520px] flex-col">
      <NativeChatMessageList session={session} isWorking={false} expandSignal={false} />
    </div>
  )
})
