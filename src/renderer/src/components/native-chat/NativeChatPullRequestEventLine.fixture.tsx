import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatPullRequestEventLine } from './NativeChatPullRequestEventLine'

const MESSAGE_ID = 'orca:pr-event:github.com/stablyai/orca#3:8d5f74b3c0e1d2f3:1'

// Keyboard focus shows the Hide button, as line hover does, without a pointer in the headless shot.
function focusHide(frame: HTMLElement): void {
  frame.ownerDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
  frame
    .querySelector<HTMLButtonElement>('button[aria-label="Don\'t show CI result lines"]')
    ?.focus()
}

export const failing = defineFixture({
  width: 560,
  render: () => (
    <NativeChatPullRequestEventLine
      block={{ type: 'text', text: 'CI failing on orca#3 at 8d5f74b', tone: 'failure' }}
      messageId={MESSAGE_ID}
    />
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
