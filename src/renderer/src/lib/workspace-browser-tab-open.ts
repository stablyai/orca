import { createBrowserLinkHostMatcher } from './browser-link-owner'
export {
  canOpenWorkspaceBrowserTabOnRuntime,
  canOpenWorkspaceBrowserTabOnSsh
} from './workspace-browser-route-eligibility'
import {
  isExpectedRuntimeBrowserRoute,
  isSshDeploymentClientBrowserRoute,
  isExpectedSshBrowserRoute
} from './workspace-browser-route-eligibility'
import type { BrowserLinkOpenContext, BrowserOpenOutcome } from './browser-link-destination'
import {
  workspaceBrowserLinkDestination,
  openClientWorkspaceBrowserLink,
  prepareRuntimeBrowserLink,
  materializedBrowserLinkOutcome
} from './workspace-browser-link-open'
import { createWebRuntimeSessionBrowserTab } from '@/runtime/web-runtime-browser-creation'
import { resolveWebRuntimeBrowserClientTargetGroup } from '@/runtime/web-runtime-browser-client-target-group'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { resolveNewBrowserTabProfile } from '@/store/slices/browser/browser-new-tab-profile'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { SearchEngine } from '../../../shared/browser-url'
import type { BrowserClientHostPlacementPreference } from '../../../shared/browser-client-host-placement'
import type { TabSplitTarget } from '@/store/slices/tabs/tabs-slice-contract'
import {
  getClientCreationActionPolicy,
  type ClientCreationActionAvailability
} from './client-creation-action-policy'
import {
  getFloatingWorkspaceOperationRoute,
  resolveWorktreeOperationRoute
} from './worktree-operation-route'
import {
  intentPresentation,
  openFailure,
  validateTarget
} from './workspace-browser-tab-presentation'

export type WorkspaceBrowserTabIntent = { kind: 'url' } | { kind: 'search'; engine: SearchEngine }

export type OpenWorkspaceBrowserTabRequest = {
  workspaceId: string
  linkContext?: BrowserLinkOpenContext
  onLinkOutcome?: (outcome: BrowserOpenOutcome) => void
  targetGroupId?: string
  /** Opens the tab in a new split beside this group instead of targetGroupId. */
  split?: TabSplitTarget
  /** Client-local unified tab id of the source; a source-following open omits targetGroupId. */
  afterTabId?: string
  url: string
  intent: WorkspaceBrowserTabIntent
  /** Keep the caller's current terminal/task surface selected while creating the tab. */
  focusOnCreate?: boolean
  /** Keep the caller's current workspace selected while creating the tab. */
  selectWorktree?: boolean
  expectedRuntimeEnvironmentId?: string
  expectedSshConnectionId?: string
  /** Keep an existing desktop provider, only after matching the asserted source owner. */
  allowClientBrowserFallback?: boolean
  /** Override placement for links whose pane explicitly requires server ownership. */
  placementPreference?: BrowserClientHostPlacementPreference
}

async function createClientBrowserTab(
  state: AppState,
  request: OpenWorkspaceBrowserTabRequest,
  hostId: ExecutionHostId,
  presentation: { error: string; title: string },
  // Desktop-rendered pages in runtime workspaces keep runtime ownership or palette/activation disowns their tabs.
  ownerHostId: ExecutionHostId = hostId
): Promise<string | null> {
  if (request.linkContext) {
    const destination = workspaceBrowserLinkDestination(request, ownerHostId, null, hostId)
    const outcome = await openClientWorkspaceBrowserLink(request, destination, presentation.title)
    request.onLinkOutcome?.(outcome)
    return outcome.status === 'opened' ? outcome.result.browserPageId : null
  }
  try {
    const created = state.createBrowserTab(request.workspaceId, request.url, {
      activate: request.focusOnCreate !== false,
      browserRuntimeEnvironmentId: null,
      focusAddressBar: false,
      executionHostId: ownerHostId,
      ...resolveNewBrowserTabProfile(state, request.workspaceId, hostId),
      targetGroupId: request.targetGroupId,
      ...(request.split ? { split: request.split } : {}),
      ...(request.afterTabId ? { afterTabId: request.afterTabId } : {}),
      title: presentation.title
    })
    return created.activePageId ?? null
  } catch (error) {
    throw openFailure(presentation.error, 'client tab creation rejected', error)
  }
}

function assertManagedBrowserEnabled(
  availability: ClientCreationActionAvailability,
  presentation: { error: string }
): asserts availability is Extract<ClientCreationActionAvailability, { state: 'enabled' }> {
  if (availability.state !== 'enabled') {
    throw openFailure(presentation.error, availability.reason)
  }
}

/** Resolves to the page id when the page renders on this desktop, else null. */
export async function openWorkspaceBrowserTab(
  request: OpenWorkspaceBrowserTabRequest
): Promise<string | null> {
  if (request.linkContext?.isCurrentRequest?.() === false) {
    request.onLinkOutcome?.({ status: 'superseded' })
    return null
  }
  const presentation = intentPresentation(request.intent, request.url)
  if (!validateTarget(request.url)) {
    throw openFailure(presentation.error, 'target is not an http(s) URL')
  }
  const state = useAppStore.getState()
  const availability = getClientCreationActionPolicy(state, request.workspaceId)['managed-browser']
  assertManagedBrowserEnabled(availability, presentation)
  const route =
    getFloatingWorkspaceOperationRoute(request.workspaceId) ??
    resolveWorktreeOperationRoute(state, request.workspaceId)
  if (!route) {
    throw openFailure(presentation.error, 'no active worktree route')
  }
  const capturedHost = request.linkContext?.linkIntent?.hostId
  if (
    capturedHost &&
    (!route.executionHostId ||
      !createBrowserLinkHostMatcher(
        state,
        request.workspaceId,
        route.executionHostId
      )(capturedHost))
  ) {
    request.onLinkOutcome?.({ status: 'refused' })
    return null
  }
  const environmentId = route.runtimeEnvironmentId?.trim() || null
  const expectedEnvironmentId =
    request.expectedRuntimeEnvironmentId === undefined
      ? null
      : request.expectedRuntimeEnvironmentId.trim()
  const expectedSshConnectionId =
    request.expectedSshConnectionId === undefined ? null : request.expectedSshConnectionId.trim()
  if (expectedEnvironmentId !== null && expectedSshConnectionId !== null) {
    throw openFailure(presentation.error, 'browser owner assertion is ambiguous')
  }
  const runtimeOwnerRoute =
    expectedEnvironmentId !== null &&
    isExpectedRuntimeBrowserRoute(
      state,
      availability,
      route,
      request.workspaceId,
      expectedEnvironmentId,
      request.allowClientBrowserFallback
    )
  const sshDeploymentClientRoute =
    expectedEnvironmentId !== null &&
    !runtimeOwnerRoute &&
    isSshDeploymentClientBrowserRoute(
      state,
      availability,
      route,
      request.workspaceId,
      expectedEnvironmentId
    )
  if (expectedEnvironmentId !== null && !runtimeOwnerRoute && !sshDeploymentClientRoute) {
    throw openFailure(presentation.error, 'asserted runtime cannot provide this managed browser')
  }
  if (
    expectedSshConnectionId !== null &&
    !isExpectedSshBrowserRoute(
      state,
      availability,
      route,
      request.workspaceId,
      expectedSshConnectionId,
      request.allowClientBrowserFallback
    )
  ) {
    throw openFailure(presentation.error, 'asserted SSH connection cannot provide this browser')
  }
  const host = parseExecutionHostId(route.executionHostId)
  if (!environmentId) {
    if (!host || host.kind === 'runtime') {
      throw openFailure(presentation.error, `unresolved client host: ${route.executionHostId}`)
    }
    return createClientBrowserTab(state, request, host.id, presentation)
  }
  if (
    route.executionHostId &&
    (!host || (host.kind === 'runtime' && host.environmentId !== environmentId))
  ) {
    throw openFailure(
      presentation.error,
      `host ${route.executionHostId} does not own runtime ${environmentId}`
    )
  }
  // Preserve desktop-provider behavior only for opted-in sources and SSH-deployed servers.
  if (
    (expectedEnvironmentId === null ||
      sshDeploymentClientRoute ||
      (request.allowClientBrowserFallback && runtimeOwnerRoute)) &&
    availability.provider === 'local-client'
  ) {
    const localHostId = host && host.kind !== 'runtime' ? host.id : LOCAL_EXECUTION_HOST_ID
    const ownerHostId =
      host?.kind === 'runtime' && route.executionHostId ? route.executionHostId : localHostId
    return createClientBrowserTab(state, request, localHostId, presentation, ownerHostId)
  }
  const destination =
    request.linkContext && route.executionHostId
      ? workspaceBrowserLinkDestination(
          request,
          route.executionHostId,
          environmentId,
          route.executionHostId
        )
      : null
  const placement = destination
    ? prepareRuntimeBrowserLink(request, destination)
    : { status: 'create' as const, groupId: request.targetGroupId }
  if (placement.status !== 'create') {
    request.onLinkOutcome?.(placement)
    return placement.status === 'opened' ? placement.result.browserPageId : null
  }
  const targetGroupId = placement.groupId
  let created = false
  try {
    created = await createWebRuntimeSessionBrowserTab({
      worktreeId: request.workspaceId,
      environmentId,
      url: request.url,
      ...resolveWebRuntimeBrowserClientTargetGroup(
        state,
        { ...request, targetGroupId, ...(destination ? { split: placement.split } : {}) },
        environmentId
      ),
      ...(destination ? { profileId: destination.sessionProfileId } : {}),
      ...(request.linkContext ? { isCurrentRequest: request.linkContext.isCurrentRequest } : {}),
      ...(destination
        ? {
            onMaterialized: (pageId: string) =>
              request.onLinkOutcome?.(materializedBrowserLinkOutcome(request, destination, pageId))
          }
        : {}),
      ...(request.afterTabId ? { clientAfterTabId: request.afterTabId } : {}),
      // Owner-pinned links need the host tab published before client reconciliation.
      ...(expectedEnvironmentId !== null ? { waitForRegistration: true } : {}),
      ...(request.placementPreference !== undefined
        ? { placementPreference: request.placementPreference }
        : {}),
      // Tab-bar opens must surface their workspace or background creates appear to do nothing.
      ...(request.focusOnCreate !== undefined ? { focusOnCreate: request.focusOnCreate } : {}),
      selectWorktree: request.selectWorktree !== false,
      stagedTitle: presentation.title,
      stagedFocusAddressBar: false,
      failureLogMode: 'operation-only'
    })
  } catch (error) {
    throw openFailure(presentation.error, 'runtime browser tab creation failed', error)
  }
  if (!created) {
    throw openFailure(presentation.error, 'runtime browser tab creation was unavailable')
  }
  return null
}

/** Detailed link results are additive to the generic page-id contract. */
export async function openWorkspaceBrowserTabForLink(
  request: OpenWorkspaceBrowserTabRequest & { linkContext: BrowserLinkOpenContext }
): Promise<BrowserOpenOutcome> {
  let outcome: BrowserOpenOutcome = { status: 'failed' }
  try {
    await openWorkspaceBrowserTab({
      ...request,
      onLinkOutcome: (result) => {
        outcome = result
      }
    })
  } catch {
    return { status: request.linkContext.isCurrentRequest?.() === false ? 'superseded' : 'failed' }
  }
  return outcome
}
