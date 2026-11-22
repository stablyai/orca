import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { BotItemQuestionShape } from '../../../../../shared/bots/bot-item-ask'
import { BotItemQuestionStep } from './BotItemQuestionStep'
import type { BotItemQuestionSteps, BotItemQuickReplyActions } from './use-bot-item-question-steps'

const RECOMMENDED = 'I rotated it; purge the transcript'
const shape: BotItemQuestionShape = {
  body: '',
  decisions: [
    {
      question: 'Is the token rotated?',
      replies: [
        { label: RECOMMENDED, recommended: true },
        { label: 'Not yet', recommended: false },
        { label: 'Keep the transcript', recommended: false }
      ]
    },
    { question: 'Close the item?', replies: [{ label: 'Close it', recommended: false }] }
  ]
}
const actions: BotItemQuickReplyActions = {
  send: () => {},
  edit: () => {},
  recover: () => {},
  type: () => {}
}

// A line reopened after an answer: the pick stands out, the recommended reply keeps its star.
function Reopened({ held }: { held: string }): React.JSX.Element {
  const steps: BotItemQuestionSteps = {
    askId: 'q1',
    shape,
    held: [held, 'Close it'],
    current: 0,
    lines: [0, 1],
    go: () => {},
    answer: () => {},
    heldCount: 1,
    sendHeld: () => {}
  }
  return (
    <div className="bg-card px-4 py-3">
      <BotItemQuestionStep shape={shape} answered={[null, null]} steps={steps} actions={actions} />
    </div>
  )
}

export const reopenedPickedRecommended = defineFixture({
  width: 340,
  render: () => <Reopened held={RECOMMENDED} />
})
export const reopenedPickedOther = defineFixture({
  width: 340,
  render: () => <Reopened held="Not yet" />
})

const three: BotItemQuestionShape = {
  body: '',
  decisions: [
    ...shape.decisions,
    { question: 'Tell the reporter?', replies: [{ label: 'Yes', recommended: true }] }
  ]
}

// Answers held on this device ahead of the last line, with the row that sends them sooner.
function Held({ count }: { count: 1 | 2 }): React.JSX.Element {
  const steps: BotItemQuestionSteps = {
    askId: 'q1',
    shape: three,
    held: count === 1 ? [RECOMMENDED, null, null] : [RECOMMENDED, 'Close it', null],
    current: count,
    lines: [0, 1, 2],
    go: () => {},
    answer: () => {},
    heldCount: count,
    sendHeld: () => {}
  }
  return (
    <div className="bg-card px-4 py-3">
      <BotItemQuestionStep
        shape={three}
        answered={[null, null, null]}
        steps={steps}
        actions={actions}
      />
    </div>
  )
}

export const heldOneNarrow = defineFixture({ width: 340, render: () => <Held count={1} /> })
export const heldTwoNarrow = defineFixture({ width: 340, render: () => <Held count={2} /> })
export const heldOneWide = defineFixture({ width: 600, render: () => <Held count={1} /> })
export const heldTwoWide = defineFixture({ width: 600, render: () => <Held count={2} /> })
// The keyboard ring on the control that sends the held answers: the row's last button.
export const heldSendFocused = defineFixture({
  width: 340,
  render: () => <Held count={2} />,
  interact: (frame) => {
    const buttons = [...frame.querySelectorAll<HTMLButtonElement>('button')]
    buttons.at(-1)?.focus({ focusVisible: true } as FocusOptions)
  }
})
