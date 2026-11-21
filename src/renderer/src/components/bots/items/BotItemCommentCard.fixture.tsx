import { defineFixture } from '../../../component-fixtures/component-fixture'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import type { BotItemAsk } from '../../../../../shared/bots/bot-item-ask'
import type { BotItemEvent } from '../../../../../shared/bots/bot-items'
import { BotItemCommentCard } from './BotItemCommentCard'
import type { BotItemQuickReplyActions } from './use-bot-item-question-steps'

const AT = new Date(2026, 10, 20, 14, 58).getTime()
const bot = { ...fixtureCos, name: 'Release helper' }
const item = makeTestBotItem(571, { title: 'Shorten the guide wording', status: 'needs_you' })
const asker = { kind: 'bot' as const, botId: fixtureCos.id, chatId: 'chat-home' }
const actions: BotItemQuickReplyActions = {
  send: () => {},
  edit: () => {},
  recover: () => {},
  type: () => {}
}

const MERGE: BotItemAsk = {
  context: [
    'Ready to merge: the guide PR.',
    '',
    '- Adds 3 short lines to each guide; no code change.',
    '- CI green (41 pass).'
  ].join('\n'),
  questions: [
    {
      prompt: 'Merge it now?',
      options: [{ label: 'Merge it' }, { label: 'Wait' }],
      recommended: 0
    }
  ]
}
const LONG: BotItemAsk = {
  context: 'Two drafts are ready. Both keep the same screenshots and the same release date.',
  questions: [
    {
      prompt:
        'Should the release note lead with the new review flow, or with the faster startup that most people asked for in the last two weeks of feedback?',
      options: [
        { label: 'Lead with the review flow' },
        { label: 'Lead with faster startup' },
        { label: 'Redraft both' }
      ],
      recommended: 1
    }
  ]
}

function ask(id: string, data: BotItemAsk, minutesAgo = 0): BotItemEvent {
  return {
    id,
    kind: 'commented',
    actor: asker,
    data: { text: 'readable copy', ask: data },
    at: AT - minutesAgo * 60_000
  }
}
const plain: BotItemEvent = {
  id: 'p1',
  kind: 'commented',
  actor: asker,
  data: { text: 'Final review passed: only the 3 lines, nothing equivalent already on main.' },
  at: AT - 11 * 60_000
}
const answer: BotItemEvent = {
  id: 'a1',
  kind: 'commented',
  actor: { kind: 'owner' },
  data: { text: 'Merge it', answers: 'q1' },
  at: AT + 60_000
}

function Feed({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex flex-col bg-sidebar px-4 py-3">{children}</div>
}

function Card({
  event,
  waiting,
  answers
}: {
  event: BotItemEvent
  waiting: boolean
  answers?: (BotItemEvent | null)[]
}): React.JSX.Element {
  return (
    <BotItemCommentCard
      bot={bot}
      item={item}
      entry={{ event, waiting, answers }}
      quickReplies={waiting ? actions : undefined}
    />
  )
}

function Pending(): React.JSX.Element {
  return (
    <Feed>
      <Card event={plain} waiting={false} />
      <Card event={ask('q1', MERGE)} waiting />
    </Feed>
  )
}

// The message that asks the owner something, while it waits: tagged, its question ruled off.
export const pending = defineFixture({ width: 340, render: () => <Pending /> })
export const pendingWide = defineFixture({ width: 560, render: () => <Pending /> })

// A long question wraps under the rule without clipping.
export const longQuestion = defineFixture({
  width: 340,
  render: () => (
    <Feed>
      <Card event={ask('q2', LONG)} waiting />
    </Feed>
  )
})

export const longOption = defineFixture({
  width: 340,
  render: () => (
    <Feed>
      <Card
        event={ask('q4', {
          ...LONG,
          questions: [
            {
              ...LONG.questions[0]!,
              options: [
                {
                  label: 'Lead with the faster startup requested in the last two weeks of feedback'
                }
              ],
              recommended: 0
            }
          ]
        })}
        waiting
      />
    </Feed>
  )
})

// Asked in prose, no quick replies: tagged, nothing to rule off.
function ProseQuestion(): React.JSX.Element {
  return (
    <Feed>
      <Card
        event={{
          id: 'q3',
          kind: 'commented',
          actor: asker,
          data: {
            text: 'The staging deploy needs a token I don’t have. Can you add it to the vault?'
          },
          at: AT
        }}
        waiting
      />
    </Feed>
  )
}

export const proseQuestion = defineFixture({ width: 340, render: () => <ProseQuestion /> })
export const proseQuestionWide = defineFixture({ width: 560, render: () => <ProseQuestion /> })

// Answered: no tag; the line reads "Question → answer" as before.
function Answered(): React.JSX.Element {
  return (
    <Feed>
      <Card event={ask('q1', MERGE)} waiting={false} answers={[answer]} />
    </Feed>
  )
}

export const answered = defineFixture({ width: 340, render: () => <Answered /> })
export const answeredWide = defineFixture({ width: 560, render: () => <Answered /> })

// Two asking messages in one feed: each carries its own tag.
function TwoPending(): React.JSX.Element {
  return (
    <Feed>
      <Card event={ask('q2', LONG, 9)} waiting />
      <Card event={plain} waiting={false} />
      <Card event={ask('q1', MERGE)} waiting />
    </Feed>
  )
}

export const twoPending = defineFixture({ width: 560, render: () => <TwoPending /> })
export const twoPendingNarrow = defineFixture({ width: 340, render: () => <TwoPending /> })
