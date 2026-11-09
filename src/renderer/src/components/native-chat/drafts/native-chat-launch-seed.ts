import type { NativeChatLaunchDraft } from './native-chat-launch-prompt'

/** The unsent TUI launch prefill and this pane’s adoption/cleanup authority. */
export type NativeChatLaunchSeed = {
  launchDraft: NativeChatLaunchDraft | null
  /** True once the transcript shows the TUI-side draft was submitted or cleared. */
  launchDraftResolved: boolean
  /** False for every pane of a split tab; gates adopting the seed, not cleanup. */
  ownsTabWideLaunchDraft: boolean
  /** The transcript is read, so whether the draft was already sent is known. */
  transcriptReady?: boolean
  /** The user's text on the agent's input line: '' when it is empty, null when unreadable. */
  readTerminalDraft?: () => string | null
}
