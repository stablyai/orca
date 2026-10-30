export type TerminalRevealIdentity = {
  worktreeId: string
  tabId: string
  leafId: string
  ptyId: string
}

export type TerminalTabCreateReply = {
  requestId: string
  tabId?: string
  title?: string
  identity?: TerminalRevealIdentity
  /** Tabs this create closed in the same write: a replace's replaced tab. */
  closed?: string[]
  error?: string
}
