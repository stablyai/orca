import { useRef } from 'react'
import {
  BOT_GROUP_SAVED_REPLY_MAX,
  type BotGroupTurn as Turn
} from '../../../../shared/bots/bot-group'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatTranscriptColumn } from '../native-chat/NativeChatTranscriptColumn'
import { BotGroupTurn } from './BotGroupTurn'
import { BotGroupTranscriptRows } from './bot-group-transcript-rows'

// Seeded data only. Each turn ended and saved its reply; its member chat's loaded rows don't hold it.
const at = 1_800_000_000_000
const reply =
  "Fixed the stale comment count in the review panel and opened the PR. The collapsed hunk header was a separate bug; I've filed it as a follow-up."

const turn = (overrides: Partial<Turn>): Turn => ({
  operationId: 'operation-1',
  botId: 'bot-1',
  botName: 'Triage',
  avatar: null,
  agent: 'claude',
  sessionId: 'bot-group-member-1',
  ...overrides
})

const codeTail = [
  'The parser now keeps the hunk offset:',
  '',
  '```ts',
  'export function hunkOffset(header: string): number {',
  '  const match = /@@ -(\\d+)/.exec(header)',
  '  return match ? Number(match[1]) : 0',
  '}',
  '```',
  '',
  'Tests pass locally; the PR is up for review.'
].join('\n')
// Cut inside a code block: the saved end begins mid-block, so the room reopens it.
const cutInsideCode =
  `${'x'.repeat(BOT_GROUP_SAVED_REPLY_MAX - codeTail.length - 40)}\n  const before = 1\n  return before\n}\n\`\`\`\n\n${codeTail}`.slice(
    -BOT_GROUP_SAVED_REPLY_MAX
  )

/** Real rows for the same turn, as they draw once the member chat's window holds it. */
const scope = { kind: 'turn', turnItemId: 'turn-1' } as const
const loaded = turn({
  reply,
  frozenItems: [
    {
      itemId: 'turn-1',
      revision: 2,
      sequence: 1,
      observedAt: at,
      turnScope: scope,
      body: {
        kind: 'turn',
        turnId: 'turn-1',
        state: 'completed',
        startedAt: at,
        completedAt: at + 2_712_000
      }
    },
    {
      itemId: 'call-1',
      revision: 2,
      sequence: 2,
      observedAt: at + 1_000,
      turnScope: scope,
      body: {
        kind: 'tool-call',
        name: 'Bash',
        input: { command: 'pnpm test review-panel' },
        state: 'completed'
      }
    },
    {
      itemId: 'reply-1',
      revision: 1,
      sequence: 3,
      observedAt: at + 2_000,
      turnScope: scope,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: reply }] }
    }
  ]
})

function Room({ turns }: { turns: Turn[] }) {
  const rootRef = useRef<HTMLDivElement>(null)
  return (
    <div ref={rootRef} data-native-chat-root className="p-4">
      <NativeChatTranscriptColumn className="space-y-6 py-6">
        {turns.map((item) => (
          <BotGroupTurn
            key={item.operationId}
            hostId="local"
            turn={item}
            files={null}
            roomLinks={{ onLinkClick: undefined, request: () => {}, rootRef }}
            roomRows={new BotGroupTranscriptRows()}
            tabId="room-tab"
            isVisible
            onStop={() => {}}
            onReply={() => {}}
            scrollMessageToTop={() => {}}
          />
        ))}
      </NativeChatTranscriptColumn>
    </div>
  )
}

/** A finished turn drawn from its saved reply. */
export const replied = defineFixture({
  width: 640,
  render: () => <Room turns={[turn({ reply })]} />
})

/** A turn that ended (stopped or failed) without a reply: the header alone. */
export const endedWithoutReply = defineFixture({
  width: 640,
  render: () => <Room turns={[turn({ reply: null })]} />
})

/** A long reply saved as its end, cut inside a code block. */
export const longReplyCutInCode = defineFixture({
  width: 640,
  render: () => <Room turns={[turn({ reply: cutInsideCode })]} />
})

/** The longest bot name at the narrowest room width: the name shortens, the status doesn't. */
export const longNameNarrow = defineFixture({
  width: 300,
  render: () => (
    <Room
      turns={[
        turn({
          botName: 'Release notes and changelog reviewer for mobile',
          reply: 'Done.'
        }),
        turn({
          operationId: 'operation-2',
          botName: 'Release notes and changelog reviewer for mobile',
          reply: null
        })
      ]}
    />
  )
})

/** Before the swap: the saved reply while the chat's rows aren't loaded. */
export const swapBefore = defineFixture({
  width: 640,
  render: () => <Room turns={[turn({ reply })]} />
})

/** After the swap: the same turn from its real rows (tool rows folded, its time shown). */
export const swapAfter = defineFixture({ width: 640, render: () => <Room turns={[loaded]} /> })

/** Known limit, unchanged: a turn still running whose start is older than the loaded rows. */
export const runningStartOutOfWindow = defineFixture({
  width: 640,
  render: () => <Room turns={[turn({})]} />
})
