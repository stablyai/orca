import { AI_VAULT_SESSION_TITLE_REFRESH_RUNTIME_CAPABILITY } from '../../../../../../shared/ai-vault/contracts/ai-vault-runtime-capabilities'
import { lastVerifiedRuntimeStatus } from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { getDecorativeAgentTitleSignature } from '../../../../../../shared/agent-status/title/agent-decorative-title-signature'
import { parsePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { findRegisteredTerminalTab } from '@/runtime/hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry'
import { isAiVaultTitleAgent } from '../../../../../../shared/ai-vault/contracts/ai-vault-session-title'
import type { AppState } from '@/store/types'
import type { RuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import type { AiVaultTitleRequest } from './ai-vault-tab-title-requests'
import { collectAgentPaneConversations } from '../../identity/pane-agent-conversations'

export function aiVaultTitleRequestKey(request: AiVaultTitleRequest): string {
  return `${request.tabId}\0${request.paneKey}\0${request.executionHostId}\0${request.agent}\0${request.providerSession.id}\0${request.providerSession.transcriptPath ?? ''}`
}

export function supportsSessionTitleRefresh(
  statuses: RuntimeStatuses,
  request: AiVaultTitleRequest
): boolean {
  const host = request.executionHostId
  return (
    host === 'local' ||
    (host.startsWith('runtime:') && runtimeSupportsSessionTitleRefresh(statuses, host.slice(8)))
  )
}

function runtimeSupportsSessionTitleRefresh(
  statuses: RuntimeStatuses,
  environmentId: string
): boolean {
  return Boolean(
    lastVerifiedRuntimeStatus(statuses.get(environmentId))?.capabilities?.includes(
      AI_VAULT_SESSION_TITLE_REFRESH_RUNTIME_CAPABILITY
    )
  )
}

/** Execution hosts whose title-refresh support flipped. Host-status pings arrive constantly, so callers check this
 * before paying for a full tab/conversation catalog walk. */
export function changedTitleRefreshHosts(
  current: RuntimeStatuses,
  prior: RuntimeStatuses
): Set<string> {
  const changed = new Set<string>()
  if (current === prior) {
    return changed
  }
  for (const environmentId of new Set([...current.keys(), ...prior.keys()])) {
    if (
      current.get(environmentId) !== prior.get(environmentId) &&
      runtimeSupportsSessionTitleRefresh(current, environmentId) !==
        runtimeSupportsSessionTitleRefresh(prior, environmentId)
    ) {
      changed.add(`runtime:${environmentId}`)
    }
  }
  return changed
}

type StoredTitle = TerminalTab['aiVaultTitle']

function storedTitleKey(worktreeId: string, tabId: string): string {
  return `${worktreeId}\0${tabId}`
}

/** Reads each request's saved title from its own workspace, visiting only the request workspaces' tabs. */
export function storedAiVaultTitles(
  state: AppState,
  requests: readonly AiVaultTitleRequest[]
): (request: AiVaultTitleRequest) => StoredTitle {
  const stored = new Map<string, StoredTitle>()
  for (const worktreeId of new Set(requests.map((request) => request.worktreeId))) {
    for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
      const key = storedTitleKey(worktreeId, tab.id)
      if (!stored.has(key)) {
        stored.set(key, tab.aiVaultTitle)
      }
    }
  }
  return (request) => stored.get(storedTitleKey(request.worktreeId, request.tabId))
}

export function titleRefreshInterval(
  statuses: RuntimeStatuses,
  request: AiVaultTitleRequest,
  stored: StoredTitle
): number {
  const missing =
    stored?.agent !== request.agent ||
    stored.sessionId !== request.providerSession.id ||
    !stored.title.trim()
  return missing || supportsSessionTitleRefresh(statuses, request) ? 20_000 : 5 * 60_000
}

function titleKey(title: string): string {
  const folded = title.replace('[ . ] Action Required', '[ ! ] Action Required')
  return getDecorativeAgentTitleSignature(folded) ?? folded
}

export function changedOwningPaneTitleRequests(
  state: AppState,
  previous: AppState,
  statuses: RuntimeStatuses
): string[] {
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
      if (!request?.refresh || !supportsSessionTitleRefresh(statuses, request)) {
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
