import { useEffect, useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import type { BotItemAsk } from '../../../../../shared/bots/bot-item-ask'
import type { BotItemAskEnd } from '../../../../../shared/bots/bot-item-question-answers'
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
  restore: () => true,
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
  answers,
  ended
}: {
  event: BotItemEvent
  waiting: boolean
  answers?: (BotItemEvent | null)[]
  ended?: BotItemAskEnd
}): React.JSX.Element {
  return (
    <BotItemCommentCard
      bot={bot}
      item={item}
      entry={{ event, waiting, answers, ended }}
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

// Answered in the owner's own words: the answer reads as a comment does, Markdown and mentions drawn.
const inWords: BotItemEvent = {
  ...answer,
  data: {
    text: 'Wait: ask [Bot: Docs helper](bot:docs-helper) to check **the tone** in `guide.md` first',
    answers: 'q1'
  }
}

function AnsweredInWords(): React.JSX.Element {
  return (
    <Feed>
      <Card event={ask('q1', MERGE)} waiting={false} answers={[inWords]} />
    </Feed>
  )
}

export const answeredInWords = defineFixture({ width: 340, render: () => <AnsweredInWords /> })

const LONG_CONTEXT: BotItemAsk = {
  ...MERGE,
  context: [
    'Ready to merge: the guide PR.',
    '',
    '- Adds 3 short lines to each guide; no code change.',
    '- CI green (41 pass).',
    '- Checked every guide page renders in light and dark.',
    '- Links in the new lines all resolve.',
    '- The wording matches the style guide.',
    '- Nothing equivalent is already on main.',
    '- Two reviewers approved.',
    '- The release notes mention it.'
  ].join('\n')
}

// Answered while the item is open: it stays whole until the item is opened again.
function AnsweredWhileOpen(): React.JSX.Element {
  const [waiting, setWaiting] = useState(true)
  useEffect(() => setWaiting(false), [])
  return (
    <Feed>
      <Card
        event={ask('q1', LONG_CONTEXT)}
        waiting={waiting}
        answers={waiting ? undefined : [answer]}
      />
    </Feed>
  )
}

export const answeredWhileOpen = defineFixture({ width: 340, render: () => <AnsweredWhileOpen /> })
export const answeredWide = defineFixture({ width: 560, render: () => <Answered /> })

// A later ask replaced an earlier one: only the later one waits; the earlier reads muted, marked replaced.
function Replaced(): React.JSX.Element {
  return (
    <Feed>
      <Card event={ask('q2', LONG, 9)} waiting={false} ended="replaced" />
      <Card event={plain} waiting={false} />
      <Card event={ask('q1', MERGE)} waiting />
    </Feed>
  )
}

export const replaced = defineFixture({ width: 560, render: () => <Replaced /> })
export const replacedNarrow = defineFixture({ width: 340, render: () => <Replaced /> })

const SET: BotItemAsk = {
  questions: [
    { prompt: 'Merge it now?', options: [{ label: 'Merge it' }, { label: 'Wait' }] },
    { prompt: 'Post the release note today?', options: [{ label: 'Yes' }, { label: 'Tomorrow' }] },
    { prompt: 'Keep the old guide linked?', options: [{ label: 'Keep it' }, { label: 'Drop it' }] }
  ]
}
const sentAnyway: BotItemEvent = {
  id: 'a2',
  kind: 'commented',
  actor: { kind: 'owner' },
  data: {
    text: 'Merge it now? → Merge it',
    answers: 'q3',
    skipped: ['Post the release note today?', 'Keep the old guide linked?']
  },
  at: AT + 60_000
}

// "send anyway" with one of three answered: the rest read muted, marked skipped.
export const skipped = defineFixture({
  width: 560,
  render: () => (
    <Feed>
      <Card
        event={ask('q3', SET)}
        waiting={false}
        answers={[sentAnyway, null, null]}
        ended="skipped"
      />
    </Feed>
  )
})

// The recommended reply among its siblings: the same pill, filled, a star before the label.
const ROTATED: BotItemAsk = {
  context: 'The deploy token showed up in the run transcript.',
  questions: [
    {
      prompt: 'Is the token rotated?',
      options: [
        { label: 'I rotated it; purge the transcript' },
        { label: 'Not yet' },
        { label: 'Keep the transcript' }
      ],
      recommended: 0
    }
  ]
}
const ROTATED_LONG: BotItemAsk = {
  ...ROTATED,
  questions: [
    {
      ...ROTATED.questions[0]!,
      options: [
        { label: 'I rotated it in the vault and on staging; purge the whole transcript now' },
        { label: 'Not yet' }
      ],
      recommended: 0
    }
  ]
}

function Recommended({ data }: { data: BotItemAsk }): React.JSX.Element {
  return (
    <Feed>
      <Card event={ask('q5', data)} waiting />
    </Feed>
  )
}

export const recommended = defineFixture({
  width: 340,
  render: () => <Recommended data={ROTATED} />
})
export const recommendedWide = defineFixture({
  width: 560,
  render: () => <Recommended data={ROTATED} />
})
export const recommendedLong = defineFixture({
  width: 340,
  render: () => <Recommended data={ROTATED_LONG} />
})
export const recommendedLongWide = defineFixture({
  width: 560,
  render: () => <Recommended data={ROTATED_LONG} />
})
export const recommendedNarrow = defineFixture({
  width: 260,
  render: () => <Recommended data={ROTATED} />
})
export const recommendedLongNarrow = defineFixture({
  width: 260,
  render: () => <Recommended data={ROTATED_LONG} />
})
export const recommendedShortNarrow = defineFixture({
  width: 260,
  render: () => <Recommended data={MERGE} />
})

// Unbroken labels: the star stays with the recommended one when it wraps; each breaks inside its chip.
const TOKEN: BotItemAsk = {
  ...ROTATED,
  questions: [
    {
      ...ROTATED.questions[0]!,
      options: [
        { label: 'TOKEN_PRODUCTION_US_EAST_1' },
        { label: 'TOKEN_STAGING_EU_WEST_2_AND_CANARY' },
        { label: 'Not yet' }
      ],
      recommended: 0
    }
  ]
}
export const recommendedToken = defineFixture({
  width: 340,
  render: () => <Recommended data={TOKEN} />
})
export const recommendedTokenNarrow = defineFixture({
  width: 260,
  render: () => <Recommended data={TOKEN} />
})
