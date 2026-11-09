import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { NativeChatTextBlock } from '../../../../../../shared/native-chat/native-chat-types'
import { NativeChatNoticeRow } from './NativeChatNoticeRow'

function guardianReview(text: string): NativeChatTextBlock {
  const head = JSON.stringify({ message: text })
  return {
    type: 'text',
    text,
    tone: 'warning',
    providerFrame: {
      provider: 'codex',
      kind: 'notification:guardianWarning',
      payload: { head, byteLength: head.length, digest: 'synthetic', truncated: false }
    }
  }
}

const reviews = [
  guardianReview(
    'Automatic approval review approved (risk: medium, authorization: high): Read-only status query.'
  ),
  guardianReview(
    'Automatic approval review denied (risk: high, authorization: low): Writes outside the workspace.'
  )
]

function GuardianReviewNotices() {
  return (
    <div className="native-chat-appearance space-y-2 p-4">
      {reviews.map((block) => (
        <NativeChatNoticeRow key={block.text} block={block} />
      ))}
    </div>
  )
}

export const guardianReviewsCollapsed = defineFixture({
  width: 720,
  render: () => <GuardianReviewNotices />
})

export const guardianReviewsExpanded = defineFixture({
  width: 720,
  render: () => <GuardianReviewNotices />,
  interact: (frame) => {
    frame.querySelectorAll('summary').forEach((summary) => summary.click())
  }
})
