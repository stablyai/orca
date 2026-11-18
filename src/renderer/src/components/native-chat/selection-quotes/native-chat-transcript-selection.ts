import { markdownMathSelectionText } from '../../../../../shared/markdown/markdown-math-selection'

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
  return markdownMathSelectionText(selection, transcript) ?? selection.toString()
}
