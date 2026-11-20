// "Type your answer" on one line of a several-question ask names that line at the start of the comment
// box, so the typed reply answers it and not the first open line. A lead alone answers nothing.
import { withoutBotItemLineLeads } from '../../../../../shared/bots/bot-item-ask'
import type { NativeChatComposerInput } from '../../native-chat/composer/editor/native-chat-composer-input'

export function caretToEndOf(node: NativeChatComposerInput | null): void {
  node?.focus()
  node?.setSelectionRange(node.value.length, node.value.length)
}

// The lead each box last put in, outside the component like the draft it names, so a reopened item still knows.
const placedLeads = new Map<string, string>()

export function useBotItemLineLead(
  scopeKey: string,
  draft: string,
  fill: (next: string) => void,
  focusReply: () => void
): { leadOnly: boolean; startLine: (lead: string, leads: readonly string[]) => void } {
  const startLine = (lead: string, leads: readonly string[]): void => {
    const rest = withoutBotItemLineLeads(draft, leads)
    placedLeads.set(scopeKey, lead)
    if (lead || rest !== draft) {
      fill(lead ? `${lead} ${rest}` : rest)
    }
    focusReply()
  }
  // A draft that is still only the lead it was given names a line and answers nothing.
  const placed = placedLeads.get(scopeKey)
  return { leadOnly: Boolean(placed) && draft.trim() === placed, startLine }
}
