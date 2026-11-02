// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureInsertionTarget } from '../dictation/dictation-insertion-target'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import { useNativeChatRootInputRouting } from './use-native-chat-root-input-routing'

const overlay = vi.hoisted(() => ({ visible: false }))
vi.mock('@/lib/visible-overlay', () => ({ hasVisibleOverlay: () => overlay.visible }))

const insertTypedText = vi.fn(() => true)
const composer: NativeChatComposerHandle = {
  focus: () => true,
  insertAgentReferences: () => false,
  insertTypedText,
  appendText: () => {},
  acceptsText: () => true,
  handlePasteEvent: () => {},
  pasteFromClipboard: () => {},
  contains: () => false
}

function Chat({ revealed }: { revealed: boolean }): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const messageRef = useRef<HTMLTextAreaElement>(null)
  const composerRef = useRef<NativeChatComposerHandle | null>({
    ...composer,
    focus: () => {
      messageRef.current?.focus()
      return true
    }
  })
  const answerRef = useRef<HTMLInputElement | null>(null)
  const routing = useNativeChatRootInputRouting({
    tabId: 'chat-tab',
    rootRef,
    composerRef,
    questionAnswerInputRef: answerRef,
    isVisible: true,
    isFocusedGroup: revealed,
    composerReady: true
  })
  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDownCapture={routing.onKeyDownCapture}
      onPointerDownCapture={routing.onPointerDownCapture}
    >
      <div data-testid="transcript">Reply text</div>
      <button type="button">Copy code</button>
      <a href="https://example.com">example.com</a>
      <div role="option" tabIndex={0} aria-selected="false">
        Option
      </div>
      <div data-native-chat-code-content tabIndex={0} data-testid="code" />
      <textarea ref={messageRef} aria-label="Message" />
      {createPortal(
        <div role="dialog">
          <button type="button">Close preview</button>
        </div>,
        document.body
      )}
    </div>
  )
}

afterEach(() => {
  cleanup()
  overlay.visible = false
  insertTypedText.mockClear()
  document.body.replaceChildren()
})

describe('useNativeChatRootInputRouting', () => {
  it('types into the composer from the transcript and from a focused button or link', () => {
    const view = render(<Chat revealed />)
    fireEvent.keyDown(view.getByTestId('transcript'), { key: 'h' })
    fireEvent.keyDown(view.getByRole('button', { name: 'Copy code' }), { key: 'i' })
    fireEvent.keyDown(view.getByRole('link', { name: 'example.com' }), { key: '!' })

    expect(insertTypedText.mock.calls).toEqual([['h'], ['i'], ['!']])
  })

  it('leaves Space with a focused button or link and letters with a composite control', () => {
    const view = render(<Chat revealed />)
    expect(fireEvent.keyDown(view.getByRole('button', { name: 'Copy code' }), { key: ' ' })).toBe(
      true
    )
    expect(fireEvent.keyDown(view.getByRole('link', { name: 'example.com' }), { key: ' ' })).toBe(
      true
    )
    expect(fireEvent.keyDown(view.getByRole('option'), { key: 'o' })).toBe(true)
    const code = view.getByTestId('code')
    code.focus()
    expect(fireEvent.keyDown(code, { key: ' ' })).toBe(true)

    expect(insertTypedText).not.toHaveBeenCalled()
  })

  it('leaves keys in a dialog the chat portals out with that dialog', () => {
    const view = render(<Chat revealed />)
    fireEvent.keyDown(view.getByRole('button', { name: 'Close preview' }), { key: 'a' })

    expect(insertTypedText).not.toHaveBeenCalled()
  })

  it('types into the composer when nothing has focus and the chat is revealed', () => {
    render(<Chat revealed />)
    expect(fireEvent.keyDown(document.body, { key: 'q' })).toBe(false)

    expect(insertTypedText).toHaveBeenCalledWith('q')
  })

  it('leaves keys typed with nothing focused alone while hidden, under an overlay, or after unmount', () => {
    const view = render(<Chat revealed={false} />)
    fireEvent.keyDown(document.body, { key: 'a' })

    view.rerender(<Chat revealed />)
    overlay.visible = true
    fireEvent.keyDown(document.body, { key: 'b' })
    overlay.visible = false

    view.unmount()
    fireEvent.keyDown(document.body, { key: 'c' })

    expect(insertTypedText).not.toHaveBeenCalled()
  })

  it('leaves keys typed with nothing focused alone while another chat is also revealed', () => {
    render(
      <>
        <Chat revealed />
        <Chat revealed />
      </>
    )
    fireEvent.keyDown(document.body, { key: 'a' })

    expect(insertTypedText).not.toHaveBeenCalled()
  })

  it('leaves keys aimed at controls outside the chat alone', () => {
    render(<Chat revealed />)
    const field = document.createElement('input')
    const list = document.createElement('div')
    list.setAttribute('role', 'listbox')
    list.tabIndex = 0
    document.body.append(field, list)

    fireEvent.keyDown(field, { key: 'a' })
    fireEvent.keyDown(list, { key: 'b' })

    expect(insertTypedText).not.toHaveBeenCalled()
  })

  it('gives dictation started from the transcript or with nothing focused to the composer', () => {
    const view = render(<Chat revealed />)
    const message = view.getByRole('textbox', { name: 'Message' })
    fireEvent.pointerDown(view.getByTestId('transcript'))
    expect(captureInsertionTarget()).toEqual({ kind: 'text', element: message })

    message.blur()
    expect(captureInsertionTarget()).toEqual({ kind: 'text', element: message })
  })

  it('leaves dictation with a focused field or a control outside the chat', () => {
    render(<Chat revealed />)
    const field = document.createElement('input')
    const button = document.createElement('button')
    document.body.append(field, button)
    field.focus()
    expect(captureInsertionTarget()).toEqual({ kind: 'text', element: field })

    button.focus()
    expect(captureInsertionTarget()).toBeNull()
  })
})
