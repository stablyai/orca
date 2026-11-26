import { useRef, type ReactNode } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { ExternalConversationLink } from '../../../../shared/connectors/external-conversation-link'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import type { QueuedMessageCard } from '../../../../shared/agent-session/view/structured-agent-session-queued-cards'
import {
  NativeChatSlackMirrorContext,
  type NativeChatSlackMirror
} from './slack-mirror/native-chat-slack-mirror'
import { NativeChatUserMessageRow } from './messages/rows/NativeChatUserMessageRow'
import { NativeChatQueuedMessageCard } from './queue/NativeChatQueuedMessageCard'

const SAM = { name: 'Sam Lee', computer: "Sam's MacBook Pro" }
const MIRRORED = 'm-mirrored'

const link: ExternalConversationLink = {
  source: 'slack',
  externalId: 'T1:C9:1792.9:U5',
  sessionId: 's',
  agent: 'claude',
  paneKey: 'chat:s',
  bot: { kind: 'bot', botId: 'release' },
  place: '#release',
  opener: { role: 'member', name: 'Sam Lee' },
  mirror: true,
  createdAt: 1,
  mirrorPosts: { [MIRRORED]: { state: 'posted', at: 1 } }
}

const message = (
  id: string,
  text: string,
  fields: Partial<NativeChatMessage> = {}
): NativeChatMessage => ({
  id,
  role: 'user',
  blocks: [{ type: 'text', text }],
  timestamp: 1_763_400_000_000,
  source: 'transcript',
  ...fields
})

const ROWS: NativeChatMessage[] = [
  message('m-1', 'I can take the Windows signing check. Start it on the build from this morning.', {
    typedByOther: SAM
  }),
  message('m-2', 'Thanks. Draft the changelog while that runs.'),
  message('m-3', 'Leave out the internal relay fixes.', { typedByOther: SAM }),
  message('m-4', 'Signing passed on my side too.', { typedByOther: { ...SAM, phone: 'iPhone' } }),
  message('m-5', 'Can you also attach the arm64 build?', {
    typedByOther: {
      name: 'Alexandra Konstantinopoulou-Hernández',
      computer: "Alexandra's MacBook Pro (work, 16-inch)"
    }
  }),
  message(MIRRORED, 'Yes, Thursday. Posting the changelog here once it is reviewed.', {
    typedByOther: SAM
  })
]

const card = (
  id: string,
  text: string,
  fields: Partial<QueuedMessageCard> = {}
): QueuedMessageCard => ({
  messageId: id,
  position: 0,
  text,
  state: 'waiting',
  hold: 'turn',
  ...fields
})

function Row({ value }: { value: NativeChatMessage }) {
  const ref = useRef<HTMLDivElement>(null)
  const markdown = value.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
  return (
    <NativeChatUserMessageRow
      message={value}
      markdown={markdown}
      prose={value.blocks}
      rowRef={ref}
      onRefolded={() => undefined}
    />
  )
}

const MIRROR: NativeChatSlackMirror = {
  bot: () => null,
  botName: 'Release bot',
  sessionId: 's',
  link,
  anyPosted: true,
  setOn: async () => true,
  post: async () => true,
  status: async () => ({ channelName: '#release', customize: true })
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <NativeChatSlackMirrorContext.Provider value={MIRROR}>
      <div className="native-chat-appearance @container flex flex-col gap-4 bg-background p-6">
        {children}
      </div>
    </NativeChatSlackMirrorContext.Provider>
  )
}

export const transcript = defineFixture({
  width: 720,
  render: () => (
    <Frame>
      {ROWS.map((row) => (
        <Row key={row.id} value={row} />
      ))}
      <ul className="rounded-lg border border-border bg-card text-card-foreground">
        <NativeChatQueuedMessageCard
          card={card('q-1', 'Also bump the minimum macOS version in the notes', {
            typedByOther: SAM
          })}
          chatWorktreeId={null}
          showsSteerShortcut={false}
          agentWorking
          onSteer={() => undefined}
          onDelete={() => undefined}
        />
        <NativeChatQueuedMessageCard
          card={card('q-2', 'Then open the release PR')}
          chatWorktreeId={null}
          showsSteerShortcut={false}
          agentWorking
          onSteer={() => undefined}
          onDelete={() => undefined}
        />
      </ul>
    </Frame>
  )
})
