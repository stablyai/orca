import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatPullRequestEventLine } from './NativeChatPullRequestEventLine'
import { NativeChatOpenedPullRequestCard } from '../../tools/pull-requests/NativeChatOpenedPullRequestCard'

// Journal keys percent-encode the line's client message id, as the host writes them.
const MESSAGE_ID = 'orca:pr-event%3Agithub.com%2Fstablyai%2Forca%233%3A8d5f74b3c0e1d2f3%3A1'
const LONG_MESSAGE_ID =
  'orca:pr-event%3Agithub.com%2Fstablyai%2Fsome-very-long-repository-name%2312345%3Aabc1234def5678%3A1'

// Keyboard focus shows the Hide button, as card hover does, without a pointer in the headless shot.
function focusHide(frame: HTMLElement): void {
  frame.ownerDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
  frame
    .querySelector<HTMLButtonElement>('button[aria-label="Don\'t show CI result lines"]')
    ?.focus()
}

export const failingBesideOpenedCard = defineFixture({
  width: 560,
  render: () => (
    <div className="space-y-2">
      <NativeChatOpenedPullRequestCard
        pullRequests={[
          {
            provider: 'github',
            url: 'https://github.com/stablyai/orca/pull/3',
            slug: { owner: 'stablyai', repo: 'orca' },
            number: 3
          }
        ]}
      />
      <NativeChatPullRequestEventLine
        block={{ type: 'text', text: 'CI failing on orca#3 at 8d5f74b', tone: 'failure' }}
        messageId={MESSAGE_ID}
      />
    </div>
  )
})
export const greenHideShown = defineFixture({
  width: 560,
  render: () => (
    <NativeChatPullRequestEventLine
      block={{ type: 'text', text: 'CI green on orca#3 at 8d5f74b', tone: 'success' }}
      messageId={MESSAGE_ID}
    />
  ),
  interact: focusHide
})
export const narrowLongHideShown = defineFixture({
  width: 340,
  render: () => (
    <NativeChatPullRequestEventLine
      block={{
        type: 'text',
        text: 'CI failing on some-very-long-repository-name#12345 at abc1234',
        tone: 'failure'
      }}
      messageId={LONG_MESSAGE_ID}
    />
  ),
  interact: focusHide
})
