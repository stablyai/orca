import { createPromptDismissalStore } from '../../../../shared/prompt-dismissal-store'

export type NativeChatPromptDismissal = Readonly<{
  /** The card's content key. */
  content: string
  /** The host wait's start for a status-backed prompt; null for a transcript-only one. */
  startedAt: number | null
  /** Answered: the card is gone. Collapsed: the user folded it to a strip above the composer. */
  state: 'answered' | 'collapsed'
}>

/** Each pane's dismissed prompt occurrence, keyed by pane key. */
export const nativeChatPromptDismissals = createPromptDismissalStore<NativeChatPromptDismissal>()

export function forgetNativeChatPromptDismissalsForTab(tabId: string): void {
  nativeChatPromptDismissals.forgetWhere((paneKey) => paneKey.startsWith(`${tabId}:`))
}
