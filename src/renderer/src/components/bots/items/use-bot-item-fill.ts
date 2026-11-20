// The comment box's own words from outside it: a quick reply's long press fills it, and "Type your
// answer" on one line of a several-question ask names that line at its start, so the typed reply
// answers it and not the first open line. A lead alone answers nothing.
import { useState, type RefObject } from 'react'
import { withoutBotItemLineLeads } from '../../../../../shared/bots/bot-item-ask'
import type { NativeChatComposerInput } from '../../native-chat/composer/editor/native-chat-composer-input'

export function useBotItemFill(
  draft: string,
  setDraft: (next: string) => void,
  input: RefObject<NativeChatComposerInput | null>,
  focusReply: () => void
): {
  caretToEnd: () => void
  fill: (text: string) => void
  lineLead: string
  startLine: (lead: string, leads: readonly string[]) => void
} {
  const [lineLead, setLineLead] = useState('')
  const caretToEnd = (): void => {
    const node = input.current
    node?.focus()
    node?.setSelectionRange(node.value.length, node.value.length)
  }
  const put = (next: string): void => {
    setDraft(next)
    if (input.current) {
      input.current.value = next
    }
    caretToEnd()
  }
  const startLine = (lead: string, leads: readonly string[]): void => {
    const rest = withoutBotItemLineLeads(draft, leads)
    setLineLead(lead)
    if (lead || rest !== draft) {
      put(lead ? `${lead} ${rest}` : rest)
    }
    focusReply()
  }
  return { caretToEnd, fill: (text) => put(`${text} `), lineLead, startLine }
}
