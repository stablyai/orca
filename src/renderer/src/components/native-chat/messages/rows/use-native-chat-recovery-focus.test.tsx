// @vitest-environment happy-dom
import { useRef } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useNativeChatRecoveryFocus } from './use-native-chat-recovery-focus'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'

afterEach(cleanup)
const sending: NativeChatDeliveryNotice = { sending: true }
const refused: NativeChatDeliveryNotice = {
  text: 'Recovery failed.',
  recoveryCardId: 'task-a',
  recoveryFocus: true
}
function Chat({ notice, visible = true }: { notice: NativeChatDeliveryNotice; visible?: boolean }) {
  const root = useRef<HTMLDivElement>(null)
  const announcement = useNativeChatRecoveryFocus(root, new Map([['orca:task-a', notice]]))
  return (
    <div ref={root} data-native-chat-root data-native-chat-visible={visible ? 'true' : 'false'}>
      <textarea aria-label="Draft" />
      {notice.sending ? (
        <div data-native-chat-message-id="orca:task-a">Pending task</div>
      ) : (
        <div data-queued-message-id="task-a">
          <button data-native-chat-retry>Send</button>
        </div>
      )}
      <span ref={announcement} role="status" aria-live="polite" />
    </div>
  )
}

it('moves focus from the untouched chat to the host-owned returned card Send', () => {
  const view = render(<Chat notice={sending} />)
  screen.getByRole('textbox').focus()
  view.rerender(<Chat notice={refused} />)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Send' }))
})

it.each(['typing', 'hidden', 'elsewhere', 'escape', 'unknown'] as const)(
  'leaves focus unchanged after %s',
  (state) => {
    const view = render(<Chat notice={sending} />)
    const input = screen.getByRole('textbox')
    input.focus()
    if (state === 'typing') {
      fireEvent.input(input, { target: { value: 'newer draft' } })
    }
    const elsewhere = document.createElement('button')
    document.body.append(elsewhere)
    if (state === 'elsewhere') {
      elsewhere.focus()
    }
    view.rerender(
      <Chat
        visible={state !== 'hidden'}
        notice={
          state === 'escape'
            ? { ...refused, recoveryFocus: false }
            : state === 'unknown'
              ? { text: 'Delivery could not be confirmed.' }
              : refused
        }
      />
    )
    expect(document.activeElement).toBe(state === 'elsewhere' ? elsewhere : input)
    elsewhere.remove()
  }
)

it('does not take focus for a historical returned card when opening the chat', () => {
  const elsewhere = document.createElement('button')
  document.body.append(elsewhere)
  elsewhere.focus()
  render(<Chat notice={refused} />)
  expect(document.activeElement).toBe(elsewhere)
  elsewhere.remove()
})
