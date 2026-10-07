import { forwardRef, useImperativeHandle, useRef } from 'react'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'
import { NativeChatComposerNotices } from './NativeChatComposerNotices'

/** The structured session tests' composer: records its props, takes real DOM focus, and draws the
 *  chat's notices above its input as the real composer does. */
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
          // Real DOM focus: the reveal-focus loop retries until focus lands in the pane.
          focus: () => {
            fieldRef.current?.focus()
            return true
          },
          insertTypedText: () => true,
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
