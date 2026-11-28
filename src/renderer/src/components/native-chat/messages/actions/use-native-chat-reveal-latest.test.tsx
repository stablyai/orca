// @vitest-environment happy-dom

import { Activity, useImperativeHandle } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  useNativeChatRevealLatest,
  type NativeChatMessageListHandle
} from './use-native-chat-reveal-latest'

afterEach(cleanup)

it('reveals a send accepted while the chat is hidden once it is shown', () => {
  const revealLatest = vi.fn<(readerWasAtEnd?: boolean) => void>()
  let captureReveal = (): (() => void) => () => {}

  function MessageList({ ref }: { ref: React.Ref<NativeChatMessageListHandle> }): null {
    useImperativeHandle(ref, () => ({
      revealLatest,
      readerAtEnd: () => false,
      revealFindMatch: () => {},
      messageCopyText: () => null
    }))
    return null
  }
  function Pane(): React.JSX.Element {
    const { messageListRef, captureRevealLatest } = useNativeChatRevealLatest()
    captureReveal = captureRevealLatest
    return <MessageList ref={messageListRef} />
  }
  const app = (visible: boolean): React.JSX.Element => (
    <Activity mode={visible ? 'visible' : 'hidden'}>
      <Pane />
    </Activity>
  )

  const { rerender } = render(app(true))
  // Read at the press while shown; the host accepts the send after the chat is hidden.
  const reveal = captureReveal()
  rerender(app(false))
  act(() => reveal())
  expect(revealLatest).not.toHaveBeenCalled()

  rerender(app(true))
  expect(revealLatest.mock.calls).toEqual([[false]])

  rerender(app(false))
  rerender(app(true))
  expect(revealLatest).toHaveBeenCalledTimes(1)
})
