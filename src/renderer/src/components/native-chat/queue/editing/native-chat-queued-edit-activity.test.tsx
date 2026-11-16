// @vitest-environment happy-dom
import { Activity, StrictMode } from 'react'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { message, SESSION, SCOPE, write, writeSpy } from './structured-queued-edit.test-fixture'
import { useStructuredAgentSessionQueuedEdit } from './use-structured-agent-session-queued-edit'
import { projectQueuedMessageCards } from '../../../../../../shared/agent-session/view/structured-agent-session-queued-cards'
import { NativeChatPaneLifetime } from '../../pane/ownership/native-chat-pane-lifetime'
import { readNativeChatDraftCache } from '../../drafts/native-chat-draft-views'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

function Queue() {
  const edit = useStructuredAgentSessionQueuedEdit({
    transport: {
      target: { kind: 'environment', environmentId: 'remote-host' },
      sessionId: SESSION,
      capable: true,
      write
    },
    messages: [message],
    cards: projectQueuedMessageCards([message], [], {}),
    submissions: [],
    composerScopeKey: SCOPE,
    promptOpen: false
  })
  return edit.editor ? (
    <>
      <textarea
        aria-label="Inline edit"
        value={edit.editor.text}
        onChange={(event) => edit.editor?.change(event.target.value)}
      />
      <button disabled={!edit.editor.canSave} onClick={edit.editor.save}>
        Save
      </button>
    </>
  ) : (
    <button onClick={() => void edit.begin('card')}>Edit</button>
  )
}

it('keeps an unsaved inline edit open across a chat switch without returning it to the chat box', async () => {
  const pane = (visible: boolean) => (
    <StrictMode>
      <NativeChatPaneLifetime isVisible={visible}>
        <Activity mode={visible ? 'visible' : 'hidden'}>
          <Queue />
        </Activity>
      </NativeChatPaneLifetime>
    </StrictMode>
  )
  const view = render(pane(true))
  fireEvent.click(view.getByRole('button', { name: 'Edit' }))
  await waitFor(() =>
    expect(view.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false)
  )
  fireEvent.change(view.getByRole('textbox'), { target: { value: 'unsaved replacement' } })
  view.rerender(pane(false))
  await act(async () => {})
  expect(toast.error).not.toHaveBeenCalled()
  expect(readNativeChatDraftCache(SCOPE)).toBe('')
  view.rerender(pane(true))
  expect(view.getByDisplayValue('unsaved replacement')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(view.getByRole('button', { name: 'Edit' }).hasAttribute('disabled')).toBe(false)
  )
  expect(writeSpy.mock.calls.at(-1)?.[2]).toMatchObject({ text: 'unsaved replacement' })
  expect(toast.error).not.toHaveBeenCalled()
  view.unmount()
  await act(async () => {})
})
