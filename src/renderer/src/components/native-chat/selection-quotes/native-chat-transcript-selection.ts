import { nativeChatSelectionText } from '../../../../../shared/native-chat/input/quotes/native-chat-quote-selection'

const TRANSCRIPT_SELECTOR = '[data-native-chat-scroll]'

export function readNativeChatTranscriptSelection(root: HTMLElement): string {
  const selection = window.getSelection()
  const transcript = root.querySelector(TRANSCRIPT_SELECTOR)
  if (
    !selection ||
    selection.isCollapsed ||
    !transcript?.contains(selection.anchorNode) ||
    !transcript.contains(selection.focusNode)
  ) {
    return ''
  }
  return nativeChatSelectionText(selection, transcript)
}
