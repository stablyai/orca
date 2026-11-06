import { AI_VAULT_SESSION_TITLE_REFRESH_RUNTIME_CAPABILITY } from '../../../shared/ai-vault/contracts/ai-vault-runtime-capabilities'
import { lastVerifiedRuntimeStatus } from '../../../shared/remote-runtime/host-status/runtime-host-status'
import { getDecorativeAgentTitleSignature } from '../../../shared/agent-status/title/agent-decorative-title-signature'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { findRegisteredTerminalTab } from '@/runtime/mounted-terminal-tab-registry'
import { isAiVaultTitleAgent } from '../../../shared/ai-vault/contracts/ai-vault-session-title'
import type { AppState } from '@/store/types'
import {
  collectAgentPaneConversations,
  type AiVaultTitleRequest
} from './ai-vault-tab-title-requests'

export function aiVaultTitleRequestKey(request: AiVaultTitleRequest): string {
  return `${request.tabId}\0${request.paneKey}\0${request.executionHostId}\0${request.agent}\0${request.providerSession.id}\0${request.providerSession.transcriptPath ?? ''}`
}

export function supportsSessionTitleRefresh(
  state: AppState,
  request: AiVaultTitleRequest
): boolean {
  const host = request.executionHostId
  return (
    host === 'local' ||
    (host.startsWith('runtime:') &&
      Boolean(
        lastVerifiedRuntimeStatus(
          state.runtimeStatusByEnvironmentId?.get(host.slice(8))
        )?.capabilities?.includes(AI_VAULT_SESSION_TITLE_REFRESH_RUNTIME_CAPABILITY)
      ))
  )
}

export function titleRefreshInterval(state: AppState, request: AiVaultTitleRequest): number {
  const stored = state.tabsByWorktree[request.worktreeId]?.find(
    (tab) => tab.id === request.tabId
  )?.aiVaultTitle
  const missing =
    stored?.agent !== request.agent ||
    stored.sessionId !== request.providerSession.id ||
    !stored.title.trim()
  return missing || supportsSessionTitleRefresh(state, request) ? 20_000 : 5 * 60_000
}

function titleKey(title: string): string {
  const folded = title.replace('[ . ] Action Required', '[ ! ] Action Required')
  return getDecorativeAgentTitleSignature(folded) ?? folded
}

export function changedOwningPaneTitleRequests(state: AppState, previous: AppState): string[] {
  const changedTabs = new Set(
    [
      ...Object.keys(state.runtimePaneTitlesByTabId ?? {}),
      ...Object.keys(previous.runtimePaneTitlesByTabId ?? {})
    ].filter(
      (tabId) =>
        state.runtimePaneTitlesByTabId?.[tabId] !== previous.runtimePaneTitlesByTabId?.[tabId]
    )
  )
  const changed: string[] = []
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    for (const tab of tabs) {
      if (!changedTabs.has(tab.id)) {
        continue
      }
      const request = collectAgentPaneConversations(state, isAiVaultTitleAgent, {
        tab: { worktreeId, tabId: tab.id },
        skipHostNamedTabs: true
      })[0]
      if (!request?.refresh || !supportsSessionTitleRefresh(state, request)) {
        continue
      }
      const leafId = parsePaneKey(request.paneKey)?.leafId
      const paneId = leafId
        ? findRegisteredTerminalTab(tab.id, worktreeId)
            ?.tab.getManager()
            ?.getNumericIdForLeaf(leafId)
        : null
      if (paneId === null || paneId === undefined) {
        continue
      }
      const current = state.runtimePaneTitlesByTabId?.[tab.id]?.[paneId] ?? ''
      const old = previous.runtimePaneTitlesByTabId?.[tab.id]?.[paneId] ?? ''
      if (titleKey(current) !== titleKey(old)) {
        changed.push(aiVaultTitleRequestKey(request))
      }
    }
  }
  return changed
}
