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

/**
 * Whether a reveal reply attests the exact pane the caller asked for. No `worktreeId`: ownership
 * is tab-keyed, so the renderer decides which workspace key the row is filed under, and
 * re-asserting the caller's key rolled back reveals that had surfaced the right pane elsewhere
 * (STA-7961).
 */
export function revealedPaneMatches(
  identity: TerminalRevealIdentity | undefined,
  expected: { tabId: string; leafId: string; ptyId: string }
): boolean {
  return Boolean(
    identity &&
    identity.tabId === expected.tabId &&
    identity.leafId === expected.leafId &&
    identity.ptyId === expected.ptyId
  )
}
