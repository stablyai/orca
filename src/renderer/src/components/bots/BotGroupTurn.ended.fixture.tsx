import { createRef } from 'react'
import type { BotGroupTurn as Turn } from '../../../../shared/bots/bot-group'
import { botGroupPageReply } from '../../../../shared/bots/bot-group'
import { mascotAvatar } from '../../../../shared/bot-avatar'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatTranscriptColumn } from '../native-chat/NativeChatTranscriptColumn'
import { MessageRow } from '../native-chat/messages/rows/NativeChatMessageRow'
import { BotGroupTurn } from './BotGroupTurn'
import { BotGroupTranscriptRows } from './bot-group-transcript-rows'

// Ended room turns whose member chat's loaded page holds none of their rows: each draws from what
// its post saved when it ended.
const base: Turn = {
  operationId: 'op',
  botId: 'bot-1',
  botName: 'Triage',
  avatar: mascotAvatar('F1'),
  agent: 'claude',
  sessionId: 'bot-group-member-1'
}

function Room({ ask, turns }: { ask: string; turns: Turn[] }): React.JSX.Element {
  return (
    <div data-native-chat-root className="p-4">
      <NativeChatTranscriptColumn className="space-y-6 py-6">
        <div className="space-y-5">
          <MessageRow
            message={{
              id: 'post',
              role: 'user',
              blocks: [{ type: 'text', text: ask }],
              timestamp: 1,
              source: 'transcript'
            }}
            expandSignal={false}
            structuredAttachments
            runtimeContext={null}
            onScrollMessageToTop={() => {}}
          />
          {turns.map((turn) => (
            <BotGroupTurn
              key={turn.operationId}
              hostId="local"
              groupId="group"
              turn={turn}
              files={null}
              roomLinks={{ onLinkClick: undefined, request: () => {}, rootRef: createRef() }}
              roomRows={new BotGroupTranscriptRows()}
              tabId="room-tab"
              isVisible
              onStop={() => {}}
              onReply={() => {}}
              scrollMessageToTop={() => {}}
            />
          ))}
        </div>
      </NativeChatTranscriptColumn>
    </div>
  )
}

const reply =
  'Audit done. The repo builds cleanly on `main`.\n\n- 3 flaky tests retried\n- 1 lint rule disabled in `sync.ts`\n\nI opened item #12 for the flaky tests.'

/** 1 · Finished after 45 minutes (the #46084 case): its saved reply, no Starting…, no Stop. */
export const finished = defineFixture({
  width: 640,
  render: () => (
    <Room
      ask="@Triage audit the repo"
      turns={[{ ...base, reply, end: 'finished', workedMs: 45 * 60_000 }]}
    />
  )
})

/** 2 · Stopped and failed without a reply: the header says how it ended, then "No reply". */
export const noReply = defineFixture({
  width: 640,
  render: () => (
    <Room
      ask="@Triage @Builder check the deploy"
      turns={[
        { ...base, operationId: 'stopped', reply: null, end: 'stopped', workedMs: 4_000 },
        {
          ...base,
          operationId: 'failed',
          botId: 'bot-2',
          botName: 'Builder',
          avatar: mascotAvatar('K2'),
          reply: null,
          end: 'failed',
          workedMs: 72_000
        }
      ]}
    />
  )
})

/** 3 · Saved before ends were: "Ended", with its reply or "No reply". */
export const savedBeforeEnds = defineFixture({
  width: 640,
  render: () => (
    <Room
      ask="@Triage @Builder summarize yesterday"
      turns={[
        { ...base, operationId: 'old', reply },
        {
          ...base,
          operationId: 'old-quiet',
          botId: 'bot-2',
          botName: 'Builder',
          avatar: mascotAvatar('K2'),
          reply: null
        }
      ]}
    />
  )
})

/** 4 · A reply past the page's cap: its end, from a whole line, after "…"; a cut code block reopens. */
export const cut = defineFixture({
  width: 640,
  render: () => (
    <Room
      ask="@Triage list every file you changed"
      turns={[
        {
          ...base,
          reply: botGroupPageReply(
            `${'Changed `src/file.ts` to read the new setting.\n'.repeat(10)}\`\`\`ts\n${'const value = read()\n'.repeat(260)}\`\`\`\n\nAll 120 files build.`
          ),
          end: 'finished',
          workedMs: 610_000
        }
      ]}
    />
  )
})
