import { focusOpenedBrowserLink } from './browser-link-focus'
import { createBrowserLinkHostMatcher } from './browser-link-owner'
import { resolveBrowserLinkSession } from './browser-link-session'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { TabSplitTarget } from '@/store/slices/tabs/tabs-slice-contract'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import type { OpenWorkspaceBrowserTabRequest } from './workspace-browser-tab-open'
import { openLocalBrowserLink, browserLinkCommitIsValid } from './browser-link-open'
import {
  selectBrowserLinkDestination,
  browserOpenResultForPage,
  currentBrowserLinkMatch,
  type BrowserLinkDestination,
  type BrowserOpenOutcome
} from './browser-link-destination'
import { activateBrowserWorkspaceTab } from './browser-workspace-tab-activation'
import {
  getFloatingWorkspaceOperationRoute,
  resolveWorktreeOperationRoute
} from './worktree-operation-route'
import { getWorkspaceClientCreationActionPolicy } from './client-creation-action-policy'
import { selectWorkspaceSurface } from './workspace-surface-reveal'
import { showWorkspaceTabs } from './http-link-browser-placement'

function ownsBrowserRoute(
  state: AppState,
  request: OpenWorkspaceBrowserTabRequest,
  destination: BrowserLinkDestination
): boolean {
  const route =
    getFloatingWorkspaceOperationRoute(request.workspaceId) ??
    resolveWorktreeOperationRoute(state, request.workspaceId)
  if (!route?.executionHostId) {
    return false
  }
  return (
    createBrowserLinkHostMatcher(
      state,
      request.workspaceId,
      destination.executionHostId
    )(route.executionHostId) &&
    (!destination.browserRuntimeEnvironmentId ||
      route.runtimeEnvironmentId === destination.browserRuntimeEnvironmentId) &&
    getWorkspaceClientCreationActionPolicy(state, request.workspaceId)['managed-browser'].state ===
      'enabled'
  )
}

export function workspaceBrowserLinkDestination(
  request: OpenWorkspaceBrowserTabRequest,
  executionHostId: ExecutionHostId,
  runtimeId: string | null,
  profileHostId: ExecutionHostId
): BrowserLinkDestination {
  const state = useAppStore.getState()
  const sessionHostId = runtimeId ? toRuntimeExecutionHostId(runtimeId) : profileHostId
  return {
    worktreeId: request.workspaceId,
    executionHostId,
    browserRuntimeEnvironmentId: runtimeId,
    profileHostId: sessionHostId,
    ...resolveBrowserLinkSession(state, request.workspaceId, sessionHostId),
    resource: { kind: 'website', url: request.url }
  }
}

export async function openClientWorkspaceBrowserLink(
  request: OpenWorkspaceBrowserTabRequest,
  destination: BrowserLinkDestination,
  title: string
): Promise<BrowserOpenOutcome> {
  if (!request.linkContext) {
    return { status: 'failed' }
  }
  return openLocalBrowserLink({
    destination,
    context: request.linkContext,
    url: request.url,
    options: { title, activate: request.focusOnCreate !== false },
    ownsRoute: (state) => ownsBrowserRoute(state, request, destination),
    reveal: () => {
      const state = useAppStore.getState()
      selectWorkspaceSurface(state, request.workspaceId)
      showWorkspaceTabs(state, request.workspaceId)
    }
  })
}

export function prepareRuntimeBrowserLink(
  request: OpenWorkspaceBrowserTabRequest,
  destination: BrowserLinkDestination
): { status: 'create'; groupId?: string; split?: TabSplitTarget } | BrowserOpenOutcome {
  const context = request.linkContext
  if (!context) {
    return { status: 'create', groupId: request.targetGroupId }
  }
  if (context.isCurrentRequest?.() === false) {
    return { status: 'superseded' }
  }
  const state = useAppStore.getState()
  const selection = selectBrowserLinkDestination(state, destination, context.linkIntent)
  if (selection.status === 'refused') {
    return selection
  }
  if (
    !browserLinkCommitIsValid(
      state,
      destination,
      context,
      selection.groupId ?? selection.split?.sourceGroupId,
      (current) => ownsBrowserRoute(current, request, destination)
    )
  ) {
    return { status: 'refused' }
  }
  if (selection.match) {
    const result = selection.match
    if (request.focusOnCreate === false || context.canReveal?.() === false) {
      return { status: 'opened', result }
    }
    selectWorkspaceSurface(state, request.workspaceId)
    showWorkspaceTabs(state, request.workspaceId)
    if (!currentBrowserLinkMatch(useAppStore.getState(), destination, result)) {
      return { status: 'refused' }
    }
    const activated = activateBrowserWorkspaceTab({
      worktreeId: result.worktreeId,
      workspaceId: result.browserWorkspaceId,
      pageId: result.browserPageId,
      executionHostId: result.executionHostId
    })
    if (!activated) {
      return { status: 'refused' }
    }
    focusOpenedBrowserLink(result)
    return { status: 'opened', result }
  }
  // No negotiated browser.tabCreate contract proves strict placement on every peer yet.
  if (context.linkIntent?.targetGroupId) {
    return { status: 'unsupported' }
  }
  return { status: 'create', groupId: selection.groupId, split: selection.split }
}

export function materializedBrowserLinkOutcome(
  request: OpenWorkspaceBrowserTabRequest,
  destination: BrowserLinkDestination,
  remotePageId: string
): BrowserOpenOutcome {
  if (request.linkContext?.isCurrentRequest?.() === false) {
    return { status: 'superseded' }
  }
  const state = useAppStore.getState()
  if (!ownsBrowserRoute(state, request, destination)) {
    return { status: 'refused' }
  }
  for (const workspace of state.browserTabsByWorktree[request.workspaceId] ?? []) {
    for (const page of state.browserPagesByWorkspace[workspace.id] ?? []) {
      const handle = state.remoteBrowserPageHandlesByPageId[page.id]
      if (
        handle?.staged ||
        handle?.environmentId !== destination.browserRuntimeEnvironmentId ||
        handle.remotePageId !== remotePageId
      ) {
        continue
      }
      const result = browserOpenResultForPage(state, destination, workspace.id, page.id)
      if (result) {
        return { status: 'opened', result }
      }
    }
  }
  return { status: 'failed' }
}
