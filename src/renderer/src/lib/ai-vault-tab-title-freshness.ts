import { AI_VAULT_SESSION_TITLE_REFRESH_RUNTIME_CAPABILITY } from '../../../shared/ai-vault/contracts/ai-vault-runtime-capabilities'
import { lastVerifiedRuntimeStatus } from '../../../shared/remote-runtime/host-status/runtime-host-status'
import { getDecorativeAgentTitleSignature } from '../../../shared/agent-status/title/agent-decorative-title-signature'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { captureMountedTerminalSurfaces } from '@/runtime/sync-runtime-graph/mobile-session-capture'
import type { AppState } from '@/store/types'
import type { AiVaultTitleRequest } from './ai-vault-tab-title-requests'

export function aiVaultTitleRequestKey(request: AiVaultTitleRequest): string {
  return `${request.tabId}\0${request.paneKey}\0${request.executionHostId}\0${request.agent}\0${request.providerSession.id}`
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

export function changedOwningPaneTitleRequests(
  state: AppState,
  previous: AppState,
  requests: AiVaultTitleRequest[]
): string[] {
  if (state.runtimePaneTitlesByTabId === previous.runtimePaneTitlesByTabId) {
    return []
  }
  const changed: string[] = []
  const capturesByWorktree = new Map<string, ReturnType<typeof captureMountedTerminalSurfaces>>()
  for (const request of requests) {
    if (!request.refresh || !supportsSessionTitleRefresh(state, request)) {
      continue
    }
    let captures = capturesByWorktree.get(request.worktreeId)
    if (!captures) {
      captures = captureMountedTerminalSurfaces(
        state.tabsByWorktree[request.worktreeId] ?? [],
        state.terminalLayoutsByTabId,
        request.worktreeId
      )
      capturesByWorktree.set(request.worktreeId, captures)
    }
    const leafId = parsePaneKey(request.paneKey)?.leafId
    const paneId = leafId ? captures.get(request.tabId)?.numericPaneIdByLeafId.get(leafId) : null
    if (paneId === null || paneId === undefined) {
      continue
    }
    const current = state.runtimePaneTitlesByTabId?.[request.tabId]?.[paneId] ?? ''
    const old = previous.runtimePaneTitlesByTabId?.[request.tabId]?.[paneId] ?? ''
    if (titleKey(current) !== titleKey(old)) {
      changed.push(aiVaultTitleRequestKey(request))
    }
  }
  return changed
}
