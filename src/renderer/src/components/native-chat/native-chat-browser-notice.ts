import type { BrowserPage } from '../../../../shared/browser-workspace-types'
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { authorityKey } from '../../../../shared/host-authority'
import {
  normalizeExternalBrowserUrl,
  resolveRemoteFailureExternalUrl
} from '../../../../shared/browser-url'
import { GRAB_SECRET_PATTERNS } from '../../../../shared/browser-grab-types'
import { resolveOwner } from '@/lib/resolve-owner'
import { resolveBrowserSourceUnifiedTab } from '@/lib/browser-workspace-source-resolution'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import type { AppState } from '@/store/types'
import { findNativeChatTabOwnerWorktreeId } from './native-chat-file-link'

export type NativeChatBrowserNoticeTarget = {
  page: BrowserPage
  executionHostId: ExecutionHostId
}

const NOTICE_STATE_KEYS = [
  'tabsByWorktree',
  'unifiedTabsByWorktree',
  'browserTabsByWorktree',
  'browserPagesByWorkspace',
  'groupsByWorktree',
  'repos',
  'worktreesByRepo',
  'detectedWorktreesByRepo',
  'folderWorkspaces',
  'projectGroups',
  'restoredRuntimeHostIdByWorkspaceSessionKey',
  'runtimeEnvironments',
  'runtimeEnvironmentCatalogHydrated',
  'removedRuntimeEnvironmentIds'
] as const

/** Streaming chat updates do not change browser ownership or its remembered targets. */
export function createNativeChatBrowserNoticeSelector(
  tabId: string,
  observedPageIds: readonly string[]
) {
  let previousRefs: readonly unknown[] | null = null
  let targets: NativeChatBrowserNoticeTarget[] = []
  return (state: AppState): readonly NativeChatBrowserNoticeTarget[] => {
    const refs = NOTICE_STATE_KEYS.map((key) => state[key])
    if (!previousRefs || refs.some((value, index) => value !== previousRefs?.[index])) {
      targets = selectNativeChatBrowserNotices(state, tabId, observedPageIds)
      previousRefs = refs
    }
    return targets
  }
}

/** Browser activity is workspace-scoped; its transport does not name a chat session. */
export function selectNativeChatBrowserNotices(
  state: AppState,
  tabId: string,
  observedPageIds: readonly string[]
): NativeChatBrowserNoticeTarget[] {
  const worktreeId = findNativeChatTabOwnerWorktreeId(state, tabId)
  if (!worktreeId) {
    return []
  }
  const chatTabs = (state.unifiedTabsByWorktree[worktreeId] ?? []).filter(
    (tab) =>
      (tab.contentType === 'terminal' && tab.entityId === tabId) ||
      (tab.contentType === 'agent-session' && tab.id === tabId)
  )
  if (chatTabs.length !== 1) {
    return []
  }
  // Why: changing the focused workspace must not change a hidden chat's owner.
  const ownerState = {
    repos: state.repos,
    worktreesByRepo: state.worktreesByRepo,
    detectedWorktreesByRepo: state.detectedWorktreesByRepo,
    folderWorkspaces: state.folderWorkspaces,
    projectGroups: state.projectGroups,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey,
    runtimeEnvironments: state.runtimeEnvironments,
    runtimeEnvironmentCatalogHydrated: state.runtimeEnvironmentCatalogHydrated,
    removedRuntimeEnvironmentIds: state.removedRuntimeEnvironmentIds
  }
  const owner = resolveOwner(ownerState, {
    workspaceId: worktreeId,
    hostId: chatTabs[0].executionHostId
  })
  if (owner.kind !== 'resolved') {
    return []
  }
  const executionHostId =
    owner.owner.endpoint.kind === 'environment'
      ? toRuntimeExecutionHostId(owner.owner.endpoint.environmentId)
      : owner.owner.at
  const observed = new Set(observedPageIds)
  const targets: NativeChatBrowserNoticeTarget[] = []
  for (const workspace of state.browserTabsByWorktree[worktreeId] ?? []) {
    for (const page of state.browserPagesByWorkspace[workspace.id] ?? []) {
      if (
        !observed.has(page.id) ||
        page.worktreeId !== worktreeId ||
        page.workspaceId !== workspace.id
      ) {
        continue
      }
      const browserTab = resolveBrowserSourceUnifiedTab(state, page.id, worktreeId)
      if (!browserTab) {
        continue
      }
      const browserOwner = resolveOwner(ownerState, {
        workspaceId: worktreeId,
        hostId: browserTab.executionHostId
      })
      if (
        browserOwner.kind !== 'resolved' ||
        authorityKey(browserOwner.owner) !== authorityKey(owner.owner)
      ) {
        continue
      }
      const runtimeId = page.browserRuntimeEnvironmentId
      if (
        runtimeId &&
        (owner.owner.endpoint.kind !== 'environment' ||
          runtimeId !== owner.owner.endpoint.environmentId)
      ) {
        continue
      }
      targets.push({ page, executionHostId })
    }
  }
  return targets
}

/** Hand off only ordinary web URLs, never a document grant or embedded credential. */
export function nativeChatBrowserExternalUrl(
  page: BrowserPage,
  executionHostId: ExecutionHostId
): string | null {
  if (page.docLocation) {
    return null
  }
  const normalized =
    executionHostId === 'local'
      ? normalizeExternalBrowserUrl(page.url)
      : resolveRemoteFailureExternalUrl(page.url)
  if (!normalized) {
    return null
  }
  const url = new URL(normalized)
  if (url.username || url.password) {
    return null
  }
  const secretKeys = [...GRAB_SECRET_PATTERNS, 'token', 'session', 'code', 'state']
  const hasSecretKey = (key: string) =>
    secretKeys.some((secret) => key.toLowerCase().includes(secret))
  if ([...url.searchParams.keys()].some(hasSecretKey)) {
    return null
  }
  const fragment = new URLSearchParams(url.hash.slice(1))
  if ([...fragment.keys()].some(hasSecretKey)) {
    return null
  }
  return normalized
}

export function nativeChatBrowserSourceOwner(
  executionHostId: ExecutionHostId
): HttpLinkSourceOwner {
  const host = parseExecutionHostId(executionHostId)
  if (host?.kind === 'runtime') {
    return { kind: 'runtime', runtimeEnvironmentId: host.environmentId }
  }
  if (host?.kind === 'ssh') {
    return { kind: 'ssh', connectionId: host.targetId }
  }
  return host?.kind === 'local' ? { kind: 'local' } : { kind: 'unknown' }
}
