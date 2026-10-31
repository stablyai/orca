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
