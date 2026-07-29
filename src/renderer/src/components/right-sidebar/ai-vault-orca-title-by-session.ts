import { aiVaultProviderSessionKey } from '../../../../shared/ai-vault-session-display-title'
import type { OriginalPaneState } from './ai-vault-original-pane'

type TabsByWorktree = OriginalPaneState['tabsByWorktree']

/**
 * Maps providerKey(agent, sessionId) → non-empty Orca tab customTitle.
 * Live entries win over retained/sleeping when both exist.
 */
export function buildAiVaultOrcaCustomTitleByProviderKey(
  state: Pick<
    OriginalPaneState,
    | 'agentStatusByPaneKey'
    | 'retainedAgentsByPaneKey'
    | 'sleepingAgentSessionsByPaneKey'
    | 'tabsByWorktree'
  >
): Map<string, string> {
  const titles = new Map<string, string>()
  const tabsById = indexTabsById(state.tabsByWorktree)

  for (const entry of Object.values(state.agentStatusByPaneKey)) {
    if (!entry?.agentType || !entry.providerSession) {
      continue
    }
    const customTitle = customTitleForTab(tabsById, entry.tabId)
    if (customTitle) {
      titles.set(aiVaultProviderSessionKey(entry.agentType, entry.providerSession.id), customTitle)
    }
  }

  for (const retained of Object.values(state.retainedAgentsByPaneKey)) {
    if (!retained?.agentType || !retained.entry.providerSession) {
      continue
    }
    const key = aiVaultProviderSessionKey(retained.agentType, retained.entry.providerSession.id)
    if (titles.has(key)) {
      continue
    }
    const customTitle = customTitleForTab(tabsById, retained.entry.tabId ?? retained.tab.id)
    if (customTitle) {
      titles.set(key, customTitle)
    }
  }

  for (const record of Object.values(state.sleepingAgentSessionsByPaneKey)) {
    if (!record) {
      continue
    }
    const key = aiVaultProviderSessionKey(record.agent, record.providerSession.id)
    if (titles.has(key)) {
      continue
    }
    const customTitle = customTitleForTab(tabsById, record.tabId)
    if (customTitle) {
      titles.set(key, customTitle)
    }
  }

  return titles
}

function indexTabsById(
  tabsByWorktree: TabsByWorktree
): Map<string, { customTitle: string | null }> {
  const byId = new Map<string, { customTitle: string | null }>()
  for (const tabs of Object.values(tabsByWorktree)) {
    if (!tabs) {
      continue
    }
    for (const tab of tabs) {
      byId.set(tab.id, tab)
    }
  }
  return byId
}

function customTitleForTab(
  tabsById: Map<string, { customTitle: string | null }>,
  tabId: string | undefined
): string | null {
  if (!tabId) {
    return null
  }
  return tabsById.get(tabId)?.customTitle?.trim() || null
}
