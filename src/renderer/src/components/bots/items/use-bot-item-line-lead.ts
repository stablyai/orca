// "Type your answer" on one line of a several-question ask names that line at the start of the comment
// box, so the typed reply answers it and not the first open line. A lead alone answers nothing.
import { withoutBotItemLineLeads } from '../../../../../shared/bots/bot-item-ask'
import type { NativeChatComposerInput } from '../../native-chat/composer/editor/native-chat-composer-input'

export function caretToEndOf(node: NativeChatComposerInput | null): void {
  node?.focus()
  node?.setSelectionRange(node.value.length, node.value.length)
}

export function useBotItemLineLead(
  draft: string,
  fill: (next: string) => void,
  focusReply: () => void
): { leadOnly: boolean; startLine: (lead: string, leads: readonly string[]) => void } {
  const startLine = (lead: string, leads: readonly string[]): void => {
    const rest = withoutBotItemLineLeads(draft, leads)
    if (lead || rest !== draft) {
      fill(lead ? `${lead} ${rest}` : rest)
    }
    focusReply()
  }
  // Read from the draft, which outlives the box: a lead alone, as it was put there, is no answer.
  return { leadOnly: /^[^\n]+ →$/.test(draft.trim()), startLine }
}
