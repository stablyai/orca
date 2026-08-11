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
  error?: string
}
