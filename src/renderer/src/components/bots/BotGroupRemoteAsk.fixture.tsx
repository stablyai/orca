import type { BotGroupRemoteAsk as RemoteAsk } from '../../../../shared/bots/bot-group'
import { mascotAvatar } from '../../../../shared/bot-avatar'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatTranscriptColumn } from '../native-chat/NativeChatTranscriptColumn'
import { BotGroupRemoteAsk } from './BotGroupRemoteAsk'

// A bot on the paired Workstation, asked from a room on this computer, in each state it can show.
const base: RemoteAsk = {
  environmentId: 'workstation',
  botId: 'builds',
  chatSessionId: 'chat-builds',
  computer: 'Workstation',
  joinedAfter: 0,
  name: 'Nightly builds',
  avatar: mascotAvatar('F1'),
  agent: 'claude',
  requestId: 'msg_000000000001',
  state: 'sent'
}

function Column({ asks }: { asks: RemoteAsk[] }): React.JSX.Element {
  return (
    <div data-native-chat-root className="p-4">
      <NativeChatTranscriptColumn className="space-y-6 py-6">
        {asks.map((ask) => (
          <BotGroupRemoteAsk key={ask.requestId} ask={ask} />
        ))}
      </NativeChatTranscriptColumn>
    </div>
  )
}

const id = (n: number) => `msg_00000000000${n}`

/** 1 · Asked, then answered: the answer shows as text under the bot's name. */
export const answered = defineFixture({
  width: 640,
  render: () => (
    <Column
      asks={[
        { ...base, requestId: id(1), state: 'sending' },
        { ...base, requestId: id(2) },
        {
          ...base,
          requestId: id(3),
          reply: {
            kind: 'answer',
            text: 'Last night’s build **passed** on `main`. Two flaky tests retried: `sync.test.ts` and `relay.test.ts`.'
          }
        }
      ]}
    />
  )
})

/** 2 · Where a question stands when there is no answer: refused, unknown, didn't answer, stopped. */
export const noAnswer = defineFixture({
  width: 640,
  render: () => (
    <Column
      asks={[
        {
          ...base,
          requestId: id(4),
          state: 'failed',
          error: "Couldn't reach Workstation. It's offline. Post again to retry."
        },
        { ...base, requestId: id(5), state: 'unknown', error: 'The request timed out.' },
        { ...base, requestId: id(6), reply: { kind: 'notice' } },
        { ...base, requestId: id(7), stopped: true }
      ]}
    />
  )
})

/** 3 · A long answer shortened on the page. */
export const shortened = defineFixture({
  width: 640,
  render: () => (
    <Column
      asks={[
        {
          ...base,
          requestId: id(8),
          reply: { kind: 'answer', text: 'Build log summary: '.repeat(20), truncated: true }
        }
      ]}
    />
  )
})

/** 4 · A narrow pane and a long name: the name gives way first, and the status keeps its words. */
export const narrow = defineFixture({
  width: 300,
  render: () => (
    <Column
      asks={[
        {
          ...base,
          name: 'Nightly builds and release checks',
          requestId: id(9),
          state: 'unknown',
          error: 'The request timed out.'
        },
        {
          ...base,
          name: 'Nightly builds and release checks',
          requestId: id(10),
          state: 'failed',
          error: "Couldn't reach Workstation. It's offline. Post again to retry."
        },
        { ...base, requestId: id(11), state: 'sending' }
      ]}
    />
  )
})
