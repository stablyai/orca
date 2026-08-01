import type { TerminalLayoutSnapshot } from './types'

export type TerminalRevealIdentity = {
  worktreeId: string
  tabId: string
  leafId: string
  ptyId: string
}

export type TerminalTabCreateReply = {
  requestId: string
  tabId?: string
  leafId?: string
  layout?: TerminalLayoutSnapshot
  title?: string
  identity?: TerminalRevealIdentity
  error?: string
}
