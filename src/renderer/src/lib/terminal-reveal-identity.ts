import type { TerminalRevealIdentity } from '../../../shared/terminal-reveal-identity'

type TerminalRevealState = {
  tabsByWorktree: Record<string, readonly { id: string }[]>
  terminalLayoutsByTabId: Record<
    string,
    { ptyIdsByLeafId?: Record<string, string | undefined> } | undefined
  >
}

export function verifyTerminalRevealIdentity(
  state: TerminalRevealState,
  expected: TerminalRevealIdentity
): TerminalRevealIdentity {
  const ownsTab = state.tabsByWorktree[expected.worktreeId]?.some(
    (tab) => tab.id === expected.tabId
  )
  const boundPtyId = state.terminalLayoutsByTabId[expected.tabId]?.ptyIdsByLeafId?.[expected.leafId]
  if (!ownsTab || boundPtyId !== expected.ptyId) {
    throw new Error('terminal_reveal_identity_mismatch')
  }
  return expected
}
