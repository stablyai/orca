import type { TuiAgent } from '../../../shared/tui-agent'

export type NativeChatLaunchPrompt = {
  tabId: string
  agent: TuiAgent
  text: string
  createdAt: number
  failed?: boolean
}

/** Keep unsent launch context as a composer draft so TUI-prefilled linked context remains visible in chat. */
export type NativeChatLaunchDraft = {
  tabId: string
  agent: TuiAgent
  text: string
  createdAt: number
  /** Set once a composer copied the text into its draft; blocks re-adoption after the user clears it. */
  adopted?: boolean
  /** Accepted mobile submission consumed the TUI-side copy. */
  resolved?: boolean
  /** Read off the input line where the user typed it, rather than typed there by Orca. */
  fromTerminal?: boolean
  /** Text of the adopted seed this one replaces; a composer still holding it takes the new text. */
  replacesText?: string
}
