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
    answer: () => {}
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
