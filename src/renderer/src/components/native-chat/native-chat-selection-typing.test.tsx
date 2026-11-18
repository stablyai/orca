// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { createRef, useRef, type ReactNode, type RefObject } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NativeChatPromptEditor } from './composer/editor/NativeChatPromptEditor'
import type { NativeChatComposerInput } from './composer/editor/native-chat-composer-input'
import type { NativeChatComposerHandle } from './composer/native-chat-composer-types'
import { useNativeChatTypedInsertion } from './composer/editor/use-native-chat-typed-insertion'
import { NativeChatSelectionQuote } from './selection-quotes/NativeChatSelectionQuote'
import { routeNativeChatRootKeyToInput } from './composer/focus/native-chat-root-key-routing'

const noop = (): void => {}

// Radix positions against layout happy-dom lacks; the open offer is drawn as Radix draws it.
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverAnchor: () => null,
  PopoverContent: ({
    children,
    onOpenAutoFocus: _onOpenAutoFocus,
    onCloseAutoFocus: _onCloseAutoFocus,
    hideWhenDetached: _hideWhenDetached,
    collisionPadding: _collisionPadding,
    sideOffset: _sideOffset,
    align: _align,
    side: _side,
    ...props
  }: Record<string, unknown> & { children: ReactNode }) => (
    <div role="dialog" data-state="open" {...props}>
      {children}
    </div>
  )
}))

beforeEach(() => {
  // Overlays count only when painted.
  const rect = new DOMRect(20, 20, 100, 20)
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: visibility checks read only `length`; happy-dom has no DOMRectList constructor.
    () => Object.assign([rect], { item: () => rect }) as unknown as DOMRectList
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

function Chat({ inputRef }: { inputRef: RefObject<NativeChatComposerInput | null> }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const insertion = useNativeChatTypedInsertion({
    textareaRef: inputRef,
    isComposing: () => false,
    setDraft: noop,
    setCaret: noop,
    setActiveSuggestion: noop
  })
  const composerRef = useRef<NativeChatComposerHandle>({
    ...insertion,
    insertAgentReferences: () => false,
    handlePasteEvent: noop,
    pasteFromClipboard: noop
  })
  return (
    <div
      ref={rootRef}
      onKeyDownCapture={(event) => routeNativeChatRootKeyToInput(event, composerRef.current, null)}
    >
      <div tabIndex={0} data-native-chat-scroll>
        <p data-native-chat-quote-source>Give me a summary of the follow-up steps.</p>
      </div>
      <NativeChatSelectionQuote rootRef={rootRef} composerRef={composerRef} enabled />
      <NativeChatPromptEditor
        inputRef={inputRef}
        initialValue=""
        disabled={false}
        placeholder="Message"
        onChange={noop}
        onSelect={noop}
      />
    </div>
  )
}

/** A key as the browser delivers it: to the focused element, which edits only if it is the editor. */
function type(key: string, input: NativeChatComposerInput): void {
  const target = document.activeElement ?? document.body
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  act(() => {
    target.dispatchEvent(event)
  })
  if (!event.defaultPrevented && input.contains?.(target)) {
    act(() => input.insertText?.(key))
  }
}

it('typing over a transcript selection keeps every space, with Add to chat showing', async () => {
  const inputRef = createRef<NativeChatComposerInput>()
  render(<Chat inputRef={inputRef} />)
  const source = screen.getByText(/Give me a summary/)
  const scroller = source.parentElement!
  act(() => {
    scroller.focus()
    const range = document.createRange()
    range.setStart(source.firstChild!, 0)
    range.setEnd(source.firstChild!, 7)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: 5, clientY: 5 }))
  })
  expect(await screen.findByText('Add to chat')).toBeTruthy()

  for (const key of 'a b') {
    type(key, inputRef.current!)
  }
  expect(inputRef.current!.value).toBe('a b')
})
