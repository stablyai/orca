// Small pieces of the item comment box: where a click on it lands, and its mic.
import { NativeChatDictationButton } from '../../native-chat/composer/controls/NativeChatDictationButton'
import type { useNativeChatDictation } from '../../native-chat/composer/editor/use-native-chat-dictation'

const CONTROLS =
  '[contenteditable], textarea, button, a, input, select, [role="button"], [tabindex]'

/** A click on the box's own padding, not on a control in it nor ending a text selection: it puts the
 *  caret at the end of the text. Only controls inside the card keep the click; the item pane around it
 *  is focusable too. */
export function isBotItemCommentPaddingClick(event: React.MouseEvent<HTMLElement>): boolean {
  const target = event.target
  const control = target instanceof Element ? target.closest(CONTROLS) : null
  return !(control && event.currentTarget.contains(control)) && !window.getSelection()?.toString()
}

export function BotItemCommentMic({
  dictation
}: {
  dictation: ReturnType<typeof useNativeChatDictation>
}): React.JSX.Element {
  return (
    <span className="ml-auto flex shrink-0">
      <NativeChatDictationButton
        disabled={dictation.dictationDisabled}
        isDictating={dictation.isDictating}
        isHoldMode={dictation.isDictationHoldMode}
        onToggle={dictation.toggleDictation}
        onHoldStart={dictation.startHoldDictation}
        onHoldEnd={dictation.stopHoldDictation}
      />
    </span>
  )
}
