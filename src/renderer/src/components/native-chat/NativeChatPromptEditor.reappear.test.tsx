// @vitest-environment happy-dom
import { Activity, createRef, useLayoutEffect, type RefObject } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatPromptEditor } from './composer/editor/NativeChatPromptEditor'
import type { NativeChatComposerInput } from './composer/editor/native-chat-composer-input'
import { promptEditor } from './composer/editor/native-chat-prompt-editor.test-support'

afterEach(cleanup)

// Stands in for the reveal-focus hook, whose layout effect focuses the composer as the pane reappears.
function FocusOnReveal({
  inputRef
}: {
  inputRef: RefObject<NativeChatComposerInput | null>
}): React.JSX.Element {
  useLayoutEffect(() => {
    inputRef.current?.focus()
  })
  return (
    <NativeChatPromptEditor
      inputRef={inputRef}
      initialValue="draft"
      disabled={false}
      placeholder="Message"
      onChange={vi.fn()}
      onSelect={vi.fn()}
    />
  )
}

function Pane({
  hidden,
  inputRef
}: {
  hidden: boolean
  inputRef: RefObject<NativeChatComposerInput | null>
}): React.JSX.Element {
  return (
    <Activity mode={hidden ? 'hidden' : 'visible'}>
      <FocusOnReveal inputRef={inputRef} />
    </Activity>
  )
}

it('publishes no input over a destroyed editor, so a reappearing pane cannot focus it', async () => {
  const inputRef = createRef<NativeChatComposerInput>()
  const view = render(<Pane hidden={false} inputRef={inputRef} />)
  const editor = promptEditor(view.getByRole('textbox', { hidden: true }))
  view.rerender(<Pane hidden inputRef={inputRef} />)
  // Tiptap destroys the editor once the hidden pane's effects disconnect, before the hidden rerender lands.
  editor.destroy()
  expect(() => view.rerender(<Pane hidden={false} inputRef={inputRef} />)).not.toThrow()
  await waitFor(() => expect(inputRef.current?.value).toBe('draft'))
})
