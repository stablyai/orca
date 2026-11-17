import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatOpenedPullRequestCard } from './NativeChatOpenedPullRequestCard'
import type { NativeChatOpenedPullRequest } from '../../../../../../shared/native-chat/tools/native-chat-opened-pull-requests'

const pullRequest: NativeChatOpenedPullRequest = {
  provider: 'github',
  url: 'https://github.com/stablyai/orca/pull/3',
  slug: { owner: 'stablyai', repo: 'orca' },
  number: 3
}

// Keyboard focus shows the Hide button, as card hover does, without a pointer in the headless shot.
function focusHide(frame: HTMLElement): void {
  frame.ownerDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
  frame.querySelector<HTMLButtonElement>('button')?.focus()
}

export const card = defineFixture({
  width: 560,
  render: () => <NativeChatOpenedPullRequestCard pullRequests={[pullRequest]} />
})
export const hideShown = defineFixture({
  width: 560,
  render: () => <NativeChatOpenedPullRequestCard pullRequests={[pullRequest]} />,
  interact: focusHide
})
