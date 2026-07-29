import type { TuiAgent } from '../../../shared/types'

export type NativeChatLaunchPrompt = {
  tabId: string
  agent: TuiAgent
  text: string
  createdAt: number
  failed?: boolean
}

/**
 * Launch-time context delivered as an UNSENT draft (e.g. a linked issue URL
 * prefilled into the agent TUI's input buffer). The chat composer adopts it as
 * its own draft so the context isn't invisible in the GUI view.
 */
export type NativeChatLaunchDraft = {
  tabId: string
  agent: TuiAgent
  text: string
  createdAt: number
  /** Set once a composer copied the text into its draft; blocks re-adoption after the user clears it. */
  adopted?: boolean
}
