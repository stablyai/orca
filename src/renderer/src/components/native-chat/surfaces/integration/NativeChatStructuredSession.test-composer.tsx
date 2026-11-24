import { forwardRef, useImperativeHandle, useRef, type ReactNode } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { NativeChatComposerNotice } from '../../composer/controls/native-chat-composer-notice'
import { NativeChatComposerNotices } from '../../composer/controls/NativeChatComposerNotices'

/** Record composer props and render notices with a real focus target for the reveal-focus loop. */
export function createStructuredSessionComposerMock(mocks: {
  composerProps: unknown
  handlePasteEvent: unknown
  pasteFromClipboard: unknown
}) {
  return {
    NativeChatComposer: forwardRef(
      (props: { notices?: readonly NativeChatComposerNotice[]; dock?: ReactNode }, ref) => {
        mocks.composerProps = props
        const fieldRef = useRef<HTMLTextAreaElement>(null)
        useImperativeHandle(ref, () => ({
          focus: () => {
            fieldRef.current?.focus()
            return true
          },
          insertTypedText: () => true,
          appendText: () => {},
          insertQuote: () => {},
          acceptsText: () => true,
          handlePasteEvent: mocks.handlePasteEvent,
          pasteFromClipboard: mocks.pasteFromClipboard,
          contains: (node: Node | null) => fieldRef.current?.contains(node) === true
        }))
        return (
          <>
            <NativeChatComposerNotices notices={props.notices ?? []} />
            {props.dock ? <TooltipProvider>{props.dock}</TooltipProvider> : null}
            <textarea ref={fieldRef} aria-label="Message" data-testid="structured-composer" />
          </>
        )
      }
    )
  }
}
