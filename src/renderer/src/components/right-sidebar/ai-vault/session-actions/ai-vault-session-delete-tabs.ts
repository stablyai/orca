import type { AppState } from '@/store/types'
import { useAppStore } from '@/store/index'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import { findOriginalAiVaultSessionPane, type OriginalPaneState } from './ai-vault-original-pane'
import { findAllOriginalAiVaultSessionPaneTabIds } from './ai-vault-original-pane-tabs'

type OpenTabLookupState = OriginalPaneState & Pick<AppState, 'unifiedTabsByWorktree'>

/** Every open tab that shows this session: its structured chat, or the terminal pane that owns it. */
export function findAiVaultSessionOpenTabIds(
  state: OpenTabLookupState,
  session: AiVaultSession
): string[] {
  const tabIds = new Set<string>()
  const structured = session.structuredSession
  if (structured) {
    for (const tab of state.unifiedTabsByWorktree[structured.workspaceId] ?? []) {
      if (tab.contentType === 'agent-session' && tab.entityId === structured.sessionId) {
        tabIds.add(tab.id)
      }
    }
  }
  for (const tabs of Object.values(state.unifiedTabsByWorktree)) {
    for (const tab of tabs) {
      if (
        tab.contentType === 'agent-session' &&
        tab.entityId === session.sessionId &&
        (!tab.executionHostId || tab.executionHostId === session.executionHostId)
      ) {
        tabIds.add(tab.id)
      }
    }
  }
  const exactTabs = findAllOriginalAiVaultSessionPaneTabIds(state, session)
  for (const tabId of exactTabs) {
    tabIds.add(tabId)
  }
  // Prompt matching is ambiguous; use it only when no pane proved the provider session.
  if (exactTabs.length === 0) {
    const originalPane = findOriginalAiVaultSessionPane(state, session)
    if (originalPane) {
      tabIds.add(originalPane.tabId)
    }
  }
  return [...tabIds]
}

/** A deleted session must not leave a tab that can no longer load it. */
export function closeAiVaultSessionTabs(session: AiVaultSession): void {
  const state = useAppStore.getState()
  for (const tabId of findAiVaultSessionOpenTabIds(state, session)) {
    state.closeUnifiedTab(tabId)
  }
}
