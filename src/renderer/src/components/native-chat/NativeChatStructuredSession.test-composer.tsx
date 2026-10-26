import { forwardRef, useImperativeHandle, useRef } from 'react'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'
import { NativeChatComposerNotices } from './NativeChatComposerNotices'

/** Record composer props and render notices with a real focus target for the reveal-focus loop. */
export function createStructuredSessionComposerMock(mocks: {
  composerProps: unknown
  handlePasteEvent: unknown
  pasteFromClipboard: unknown
}) {
  return {
    NativeChatComposer: forwardRef(
      (props: { notices?: readonly NativeChatComposerNotice[] }, ref) => {
        mocks.composerProps = props
        const fieldRef = useRef<HTMLTextAreaElement>(null)
        useImperativeHandle(ref, () => ({
          focus: () => {
            fieldRef.current?.focus()
            return true
          },
          insertTypedText: () => true,
          appendText: () => {},
          acceptsText: () => true,
          handlePasteEvent: mocks.handlePasteEvent,
          pasteFromClipboard: mocks.pasteFromClipboard,
          contains: (node: Node | null) => fieldRef.current?.contains(node) === true
        }))
        return (
          <>
            <NativeChatComposerNotices notices={props.notices ?? []} />
            <textarea ref={fieldRef} aria-label="Message" data-testid="structured-composer" />
          </>
        )
      }
    )
  }
}
