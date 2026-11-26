import { useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { BotItemQuestionShape } from '../../../../../shared/bots/bot-item-ask'
import {
  botItemHeldAnswer,
  botItemHeldAnswerIsReply,
  type BotItemHeldAnswer
} from '../../../../../shared/bots/bot-item-held-answers'
import { BotItemQuestionStep } from './BotItemQuestionStep'
import type { BotItemQuestionSteps, BotItemQuickReplyActions } from './use-bot-item-question-steps'

const two: BotItemQuestionShape = {
  body: '',
  decisions: [
    {
      question: 'Ship the new sidebar to everyone?',
      replies: [
        { label: 'Ship it', recommended: true },
        { label: 'Beta first', recommended: false }
      ]
    },
    {
      question: 'Keep the old layout as an option?',
      replies: [
        { label: 'Yes, for a month', recommended: true },
        { label: 'No', recommended: false }
      ]
    }
  ]
}
const four: BotItemQuestionShape = {
  body: '',
  decisions: [
    ...two.decisions,
    {
      question: 'Who reviews the follow-up?',
      replies: [
        { label: 'Design', recommended: false },
        { label: 'Me', recommended: true }
      ]
    },
    {
      question: 'When should it go out?',
      replies: [
        { label: 'Today', recommended: false },
        { label: 'Next release', recommended: true },
        { label: 'After the beta', recommended: false }
      ]
    }
  ]
}
const long: BotItemQuestionShape = {
  body: '',
  decisions: [
    {
      question:
        'Ship the new sidebar to everyone now that the checks are green and both reviews passed on the same build?',
      replies: [
        { label: 'Ship it', recommended: true },
        { label: 'Beta first', recommended: false }
      ]
    },
    two.decisions[1]!
  ]
}
// A long answer: past 60% it gives way too, so the question still reads.
const longAnswer: BotItemQuestionShape = {
  body: '',
  decisions: [
    {
      question: long.decisions[0]!.question,
      replies: [
        {
          label: 'Beta first, then everyone after two weeks of feedback from the testers',
          recommended: false
        },
        { label: 'Ship it', recommended: true }
      ]
    },
    two.decisions[1]!
  ]
}
// A question with no quick replies: answered in your own words.
const ownWords: BotItemQuestionShape = {
  body: '',
  decisions: [two.decisions[0]!, { question: 'Anything to tell the testers?', replies: [] }]
}

const actions: BotItemQuickReplyActions = {
  send: () => {},
  edit: () => {},
  restore: () => true,
  type: () => {}
}

/** The card with its picks kept here, so a fixture's clicks pick, swap and clear as in the app.
 *  `answered`: lines a posted comment, or a send on its way, answered. */
function Card({
  shape,
  picked,
  answered = shape.decisions.map(() => null)
}: {
  shape: BotItemQuestionShape
  picked: readonly (string | BotItemHeldAnswer | null)[]
  answered?: readonly (string | null)[]
}): React.JSX.Element {
  const [picks, setPicks] = useState(() =>
    picked.map((pick) => (typeof pick === 'string' ? botItemHeldAnswer(pick) : pick))
  )
  const lines = shape.decisions.flatMap((_, index) => (answered[index] ? [] : [index]))
  const steps: BotItemQuestionSteps = {
    askId: 'q1',
    shape,
    picks: picks.map((pick, index) => (lines.includes(index) ? pick : null)),
    lines,
    pick: (index, words) =>
      setPicks((previous) =>
        previous.map((held, at) =>
          at === index
            ? botItemHeldAnswerIsReply(held, words)
              ? null
              : botItemHeldAnswer(words)
            : held
        )
      ),
    bind: () => {},
    send: () => (picks.some(Boolean) ? 'sent' : lines.length > 0 ? 'empty' : 'none'),
    sending: false
  }
  return (
    <div className="bg-card px-3.5 py-3">
      <BotItemQuestionStep shape={shape} answered={answered} steps={steps} actions={actions} />
    </div>
  )
}

const none = (shape: BotItemQuestionShape) => shape.decisions.map(() => null)

export const twoNone = defineFixture({
  width: 300,
  render: () => <Card shape={two} picked={none(two)} />
})
export const twoPartial = defineFixture({
  width: 300,
  render: () => <Card shape={two} picked={['Ship it', null]} />
})
export const twoAll = defineFixture({
  width: 300,
  render: () => <Card shape={two} picked={['Beta first', 'No']} />
})
export const twoPartialWide = defineFixture({
  width: 600,
  render: () => <Card shape={two} picked={['Ship it', null]} />
})
export const fourNone = defineFixture({
  width: 300,
  render: () => <Card shape={four} picked={none(four)} />
})
export const fourPartial = defineFixture({
  width: 300,
  render: () => <Card shape={four} picked={['Ship it', null, 'Me', null]} />
})
export const fourAll = defineFixture({
  width: 300,
  render: () => <Card shape={four} picked={['Ship it', 'No', 'Design', 'After the beta']} />
})
export const fourNoneWide = defineFixture({
  width: 600,
  render: () => <Card shape={four} picked={none(four)} />
})
export const fourPartialWide = defineFixture({
  width: 600,
  render: () => <Card shape={four} picked={['Ship it', null, 'Me', null]} />
})
export const fourAllWide = defineFixture({
  width: 600,
  render: () => <Card shape={four} picked={['Ship it', 'No', 'Design', 'After the beta']} />
})
// A long question folds to one row: the question gives way, the answer stays whole.
export const longFolded = defineFixture({
  width: 300,
  render: () => <Card shape={long} picked={['Beta first', null]} />
})
export const longFoldedWide = defineFixture({
  width: 600,
  render: () => <Card shape={long} picked={['Beta first', null]} />
})
// A folded pick reopened: the pick is solid with its check, the recommended reply loses its star.
export const reopened = defineFixture({
  width: 300,
  render: () => <Card shape={two} picked={['Beta first', null]} />,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button[title^="Ship the new sidebar"]')?.click()
  }
})
// A line answered, or sent and on its way, folds and stays; the count is of all lines.
export const oneSent = defineFixture({
  width: 300,
  render: () => (
    <Card shape={four} picked={[null, 'No', null, null]} answered={['Ship it', null, null, null]} />
  )
})
export const typeYourAnswer = defineFixture({
  width: 300,
  render: () => <Card shape={ownWords} picked={['Ship it', null]} />
})
// The keyboard ring on Send.
export const sendFocused = defineFixture({
  width: 300,
  render: () => <Card shape={four} picked={['Ship it', null, 'Me', null]} />,
  interact: (frame) => {
    const buttons = [...frame.querySelectorAll<HTMLButtonElement>('button')]
    buttons.at(-1)?.focus({ focusVisible: true })
  }
})
export const longAnswerFolded = defineFixture({
  width: 300,
  render: () => (
    <Card
      shape={longAnswer}
      picked={['Beta first, then everyone after two weeks of feedback from the testers', null]}
    />
  )
})
// A typed answer held with a screenshot and a file: they show under its folded line.
const STORE = '/tmp/agent-session-attachments/0123abcd-0123-4567-89ab-0123456789ab'
export const heldWithFiles = defineFixture({
  width: 300,
  render: () => (
    <Card
      shape={ownWords}
      picked={[
        botItemHeldAnswer(`Beta first, see [Image #1] and @${STORE}/notes.txt`, [
          `${STORE}/screenshot.png`
        ]),
        null
      ]}
    />
  )
})
