import { createWebRuntimeSessionBrowserTab } from '@/runtime/web-runtime-browser-creation'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { SearchEngine } from '../../../shared/browser-url'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { BROWSER_SCREENCAST_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { BrowserClientHostPlacementPreference } from '../../../shared/browser-client-host-placement'
import {
  getClientCreationActionPolicy,
  type ClientCreationActionAvailability
} from './client-creation-action-policy'
import { resolveWorktreeOperationRoute } from './worktree-operation-route'
import {
  intentPresentation,
  openFailure,
  validateTarget
} from './workspace-browser-tab-presentation'
import { getExecutionHostIdForWorktree } from './worktree-runtime-owner'
import { resolveSshWorkspaceBrowserRouteEligibility } from './ssh-workspace-browser-route-eligibility'

export type WorkspaceBrowserTabIntent = { kind: 'url' } | { kind: 'search'; engine: SearchEngine }

export type OpenWorkspaceBrowserTabRequest = {
  workspaceId: string
  targetGroupId?: string
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
  /** Override placement for links whose pane explicitly requires server ownership. */
  placementPreference?: BrowserClientHostPlacementPreference
}

function isExpectedRuntimeBrowserRoute(
  state: AppState,
  availability: ClientCreationActionAvailability,
  route: ReturnType<typeof resolveWorktreeOperationRoute>,
  workspaceId: string,
  expectedRuntimeEnvironmentId: string
): boolean {
  if (availability.state !== 'enabled' || workspaceId === FLOATING_TERMINAL_WORKTREE_ID || !route) {
    return false
  }
  const expectedEnvironmentId = expectedRuntimeEnvironmentId.trim()
  const environmentId = route.runtimeEnvironmentId?.trim() || null
  const capabilities =
    state.runtimeStatusByEnvironmentId?.get(expectedEnvironmentId)?.status?.capabilities
  if (
    environmentId !== expectedEnvironmentId ||
    !capabilities?.includes(BROWSER_SCREENCAST_RUNTIME_CAPABILITY)
  ) {
    return false
  }
  const host = parseExecutionHostId(route.executionHostId)
  return (
    !route.executionHostId ||
    Boolean(host && (host.kind !== 'runtime' || host.environmentId === environmentId))
  )
}

// Why: a managed server reached over SSH has no browser of its own, so its links open on this
// desktop, whose page the SSH-routed browser gate sends through that host (as new tabs do).
function isSshDeploymentClientBrowserRoute(
  state: AppState,
  availability: ClientCreationActionAvailability,
  route: ReturnType<typeof resolveWorktreeOperationRoute>,
  workspaceId: string,
  expectedRuntimeEnvironmentId: string
): boolean {
  if (
    availability.state !== 'enabled' ||
    availability.provider !== 'local-client' ||
    workspaceId === FLOATING_TERMINAL_WORKTREE_ID ||
    !route
  ) {
    return false
  }
  const expectedEnvironmentId = expectedRuntimeEnvironmentId.trim()
  const host = parseExecutionHostId(route.executionHostId)
  const eligibility = resolveSshWorkspaceBrowserRouteEligibility(
    route.executionHostId,
    state.settings,
    state.runtimeEnvironments
  )
  return (
    Boolean(expectedEnvironmentId) &&
    route.runtimeEnvironmentId?.trim() === expectedEnvironmentId &&
    host?.kind === 'runtime' &&
    host.environmentId === expectedEnvironmentId &&
    eligibility?.eligible === true
  )
}

export function canOpenWorkspaceBrowserTabOnRuntime(
  state: AppState,
  workspaceId: string,
  expectedRuntimeEnvironmentId: string
): boolean {
  const availability = getClientCreationActionPolicy(state, workspaceId)['managed-browser']
  const route = resolveWorktreeOperationRoute(state, workspaceId)
  return (
    isExpectedRuntimeBrowserRoute(
      state,
      availability,
      route,
      workspaceId,
      expectedRuntimeEnvironmentId
    ) ||
    isSshDeploymentClientBrowserRoute(
      state,
      availability,
      route,
      workspaceId,
      expectedRuntimeEnvironmentId
    )
  )
}

function isExpectedSshBrowserRoute(
  state: AppState,
  availability: ClientCreationActionAvailability,
  route: ReturnType<typeof resolveWorktreeOperationRoute>,
  workspaceId: string,
  expectedSshConnectionId: string
): boolean {
  if (availability.state !== 'enabled' || workspaceId === FLOATING_TERMINAL_WORKTREE_ID || !route) {
    return false
  }
  const expectedTargetId = expectedSshConnectionId.trim()
  const eligibility = resolveSshWorkspaceBrowserRouteEligibility(
    getExecutionHostIdForWorktree(state, workspaceId),
    state.settings
  )
  const host = parseExecutionHostId(route.executionHostId)
  return (
    Boolean(expectedTargetId) &&
    route.runtimeEnvironmentId === null &&
    eligibility?.eligible === true &&
    eligibility.targetId === expectedTargetId &&
    host?.kind === 'ssh' &&
    host.targetId === expectedTargetId
  )
}

export function canOpenWorkspaceBrowserTabOnSsh(
  state: AppState,
  workspaceId: string,
  expectedSshConnectionId: string
): boolean {
  const availability = getClientCreationActionPolicy(state, workspaceId)['managed-browser']
  const route = resolveWorktreeOperationRoute(state, workspaceId)
  return isExpectedSshBrowserRoute(state, availability, route, workspaceId, expectedSshConnectionId)
}

function createClientBrowserTab(
  state: AppState,
  request: OpenWorkspaceBrowserTabRequest,
  hostId: ExecutionHostId,
  presentation: { error: string; title: string },
  // Why: a desktop-hosted page in a runtime workspace stays owned by that runtime, or the
  // unified tab is disowned from its worktree (palette and activation skip it).
  ownerHostId: ExecutionHostId = hostId
): void {
  try {
    state.createBrowserTab(request.workspaceId, request.url, {
      activate: request.focusOnCreate !== false,
      browserRuntimeEnvironmentId: null,
      focusAddressBar: false,
      executionHostId: ownerHostId,
      sessionProfileId:
        state.defaultBrowserSessionProfileIdByHostId[hostId] ??
        state.defaultBrowserSessionProfileId,
      targetGroupId: request.targetGroupId,
      ...(request.afterTabId ? { afterTabId: request.afterTabId } : {}),
      title: presentation.title
    })
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

export async function openWorkspaceBrowserTab(
  request: OpenWorkspaceBrowserTabRequest
): Promise<void> {
  const presentation = intentPresentation(request.intent, request.url)
  if (!validateTarget(request.url)) {
    throw openFailure(presentation.error, 'target is not an http(s) URL')
  }
  const state = useAppStore.getState()
  const availability = getClientCreationActionPolicy(state, request.workspaceId)['managed-browser']
  assertManagedBrowserEnabled(availability, presentation)
  const route = resolveWorktreeOperationRoute(state, request.workspaceId)
  if (!route) {
    throw openFailure(presentation.error, 'no active worktree route')
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
      expectedEnvironmentId
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
      expectedSshConnectionId
    )
  ) {
    throw openFailure(presentation.error, 'asserted SSH connection cannot provide this browser')
  }
  const host = parseExecutionHostId(route.executionHostId)
  if (!environmentId) {
    if (!host || host.kind === 'runtime') {
      throw openFailure(presentation.error, `unresolved client host: ${route.executionHostId}`)
    }
    createClientBrowserTab(state, request, host.id, presentation)
    return
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
  // An asserted runtime owns links opened from remote panes; provider policy may describe the
  // viewing client's generic browser surface rather than that pane's execution host. The one
  // exception is an SSH-deployed server, whose links this desktop hosts on the SSH route.
  if (
    (expectedEnvironmentId === null || sshDeploymentClientRoute) &&
    availability.provider === 'local-client'
  ) {
    const localHostId = host && host.kind !== 'runtime' ? host.id : LOCAL_EXECUTION_HOST_ID
    const ownerHostId =
      host?.kind === 'runtime' && route.executionHostId ? route.executionHostId : localHostId
    createClientBrowserTab(state, request, localHostId, presentation, ownerHostId)
    return
  }
  let created = false
  try {
    created = await createWebRuntimeSessionBrowserTab({
      worktreeId: request.workspaceId,
      environmentId,
      url: request.url,
      targetGroupId: request.targetGroupId,
      // Client placement survives older hosts publishing a page before the create response.
      ...(request.targetGroupId ? { clientTargetGroupId: request.targetGroupId } : {}),
      ...(request.afterTabId ? { clientAfterTabId: request.afterTabId } : {}),
      // Owner-pinned links need the host tab published before client reconciliation.
      ...(expectedEnvironmentId !== null ? { waitForRegistration: true } : {}),
      ...(request.placementPreference !== undefined
        ? { placementPreference: request.placementPreference }
        : {}),
      // Why: the tab is opened from this workspace's tab bar, so surface that
      // workspace — otherwise a background worktree looks like nothing happened.
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
}
