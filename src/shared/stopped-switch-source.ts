import type { AiVaultAgent } from './ai-vault-types'

/** One stopped switch source: the exact pane whose process a switch stopped and kept on screen. */
export type StoppedSwitchSource = {
  worktreeId: string
  tabId: string
  leafId: string
  ptyId: string
  incarnationId?: string
  /** The chat a replace put in this tab's slot; the window settles the pane only once it has it. */
  replacedBySessionId?: string
  /** Present when a switch stopped it, naming the agent the pane shows as stopped; absent when an
   *  addressed close stopped it but could not remove its tab, which exits as any pane does. */
  switched?: { agent?: AiVaultAgent }
}

/**
 * Main's fact on a terminal row: a switch stopped this exact process with proof and nothing
 * replaced its pane. It names the conversation the process ran, so every viewer shows the stopped
 * pane and offers the retry from the same fact. Current state, never an obligation.
 */
export type StoppedSwitchSourceFact = {
  ptyId: string
  incarnationId: string
  agent: AiVaultAgent
  providerSessionId: string
}
