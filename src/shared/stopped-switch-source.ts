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
  switched?: { agent?: AiVaultAgent; screen?: StoppedSwitchSourceScreen }
}

/**
 * The stopped pane's screen as the stop's presentation hold froze it, before the agent was told to
 * exit, so it never holds the CLI's exit text. Main's headless image (screen only, at its own grid),
 * which a viewer with no live screen paints instead of reattaching.
 */
export type StoppedSwitchSourceScreen = {
  data: string
  cols: number
  rows: number
  alternateScreen?: boolean
  scrollbackAnsi?: string
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
  /** Absent from older hosts, or when the frame couldn't be read: the pane keeps what it shows. */
  screen?: StoppedSwitchSourceScreen
}
