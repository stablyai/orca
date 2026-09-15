import type { useAppStore } from '@/store'
import { parsePtySessionId, PTY_SESSION_ID_SEPARATOR } from '../../../shared/pty-session-id-format'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getProviderSessionClaimKey } from './sleeping-agent-pane-ownership'
import { isStructuredAgentSyntheticSleepingRecord } from './structured-agent-synthetic-sleeping-record'
import type { StructuredActivationInventory } from './worktree-agent-structured-inventory'

type ActivationClaimsStore = Pick<
  ReturnType<typeof useAppStore.getState>,
  | 'ptyIdsByTabId'
  | 'sleepingAgentSessionsByPaneKey'
  | 'terminalLayoutsByTabId'
  | 'unifiedTabsByWorktree'
>

export function workspaceHasSleepingAgentSessions(
  state: Pick<ActivationClaimsStore, 'sleepingAgentSessionsByPaneKey'>,
  worktreeId: string
): boolean {
  return Object.values(state.sleepingAgentSessionsByPaneKey).some(
    (record) => record.worktreeId === worktreeId
  )
}

export function workspaceHasStructuredAgentSession(
  store: Pick<ActivationClaimsStore, 'unifiedTabsByWorktree'>,
  worktreeId: string
): boolean {
  return (store.unifiedTabsByWorktree[worktreeId] ?? []).some(
    (tab) => tab.contentType === 'agent-session'
  )
}

export function sessionBelongsToWorkspace(sessionId: string, worktreeId: string): boolean {
  if (parsePtySessionId(sessionId).worktreeId === worktreeId) {
    return true
  }
  const scope = parseWorkspaceKey(worktreeId)
  return (
    scope?.type === 'folder' &&
    sessionId.startsWith(`${worktreeId}${PTY_SESSION_ID_SEPARATOR}`) &&
    sessionId.length > worktreeId.length + PTY_SESSION_ID_SEPARATOR.length
  )
}

export function liveSleepingAgentClaimKeys(
  store: ActivationClaimsStore,
  worktreeId: string,
  livePtyIds: ReadonlySet<string>,
  structuredInventory: StructuredActivationInventory | null
): Set<string> {
  const keys = new Set<string>()
  for (const record of Object.values(store.sleepingAgentSessionsByPaneKey)) {
    if (record.worktreeId !== worktreeId) {
      continue
    }
    const stable = parsePaneKey(record.paneKey)
    const tabId = record.tabId ?? stable?.tabId
    const layoutPtyId = stable
      ? store.terminalLayoutsByTabId[stable.tabId]?.ptyIdsByLeafId?.[stable.leafId]
      : undefined
    const tabPtyIds = tabId ? store.ptyIdsByTabId[tabId] : undefined
    const structuredOwner =
      stable && isStructuredAgentSyntheticSleepingRecord(record)
        ? structuredInventory?.ownerBySessionId.get(record.providerSession.id)
        : undefined
    if (structuredOwner?.owner === 'native') {
      keys.add(getProviderSessionClaimKey(record))
      continue
    }
    const structuredOwnerPtyId =
      structuredOwner?.owner === 'tui' ? structuredOwner.terminal?.ptyId : undefined
    const persistedPtyId =
      layoutPtyId ?? (tabPtyIds?.length === 1 ? tabPtyIds[0] : undefined) ?? structuredOwnerPtyId
    if (persistedPtyId && livePtyIds.has(persistedPtyId)) {
      keys.add(getProviderSessionClaimKey(record))
    }
  }
  return keys
}
