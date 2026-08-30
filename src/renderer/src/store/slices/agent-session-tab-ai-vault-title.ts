import type { AiVaultSessionTitle } from '../../../../shared/ai-vault-session-title'
import type { Tab } from '../../../../shared/tab-types'

function sameTitle(
  left: AiVaultSessionTitle | null | undefined,
  right: AiVaultSessionTitle | null | undefined
): boolean {
  return (
    left?.agent === right?.agent &&
    left?.sessionId === right?.sessionId &&
    left?.title === right?.title
  )
}

/**
 * Names a structured chat tab from the AI Vault pipeline. Structured chats have no terminal tab to
 * carry the name, so the unified row is the only record of it.
 *
 * Returns null when nothing changed, so an unchanged provider name never re-renders the tab strip.
 */
export function applyAgentSessionAiVaultTitle(
  unifiedTabsByWorktree: Record<string, Tab[]>,
  tabId: string,
  aiVaultTitle: AiVaultSessionTitle | null
): Record<string, Tab[]> | null {
  for (const [worktreeId, tabs] of Object.entries(unifiedTabsByWorktree)) {
    const current = tabs.find((tab) => tab.contentType === 'agent-session' && tab.id === tabId)
    if (!current || sameTitle(current.aiVaultTitle, aiVaultTitle)) {
      continue
    }
    return {
      ...unifiedTabsByWorktree,
      [worktreeId]: tabs.map((tab) => (tab.id === tabId ? { ...tab, aiVaultTitle } : tab))
    }
  }
  return null
}
