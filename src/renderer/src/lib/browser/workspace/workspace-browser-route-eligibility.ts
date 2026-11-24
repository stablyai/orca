import { parseExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/workspace/identity/floating-workspace-id'
import '../../../../../shared/remote-runtime/protocol/protocol-version'
import { BROWSER_SCREENCAST_RUNTIME_CAPABILITY } from '../../../../../shared/browser/runtime/browser-runtime-capabilities'
import {
  getWorkspaceClientCreationActionPolicy,
  runtimeHostsPagesOnThisDesktop
} from '../../workspace/creation/surface-policy/client-creation-action-policy'
import type { ClientCreationActionAvailability } from '../../workspace/creation/surface-policy/client-creation-action-policy'
import { resolveWorktreeOperationRoute } from '../../workspace/ownership/worktree-operation-route'
import { getExecutionHostIdForWorktree } from '../../workspace/ownership/worktree-runtime-owner'
import { resolveSshWorkspaceBrowserRouteEligibility } from './ssh-workspace-browser-route-eligibility'
import type { AppState } from '@/store/types'
import { readAppRuntimeStatuses } from '@/store/slices/runtime-status/views/app-runtime-status-binding'
import type { HttpLinkSourceOwner } from '../navigation/http-link-routing'

export function isExpectedRuntimeBrowserRoute(
  state: AppState,
  availability: ClientCreationActionAvailability,
  route: ReturnType<typeof resolveWorktreeOperationRoute>,
  workspaceId: string,
  expectedRuntimeEnvironmentId: string,
  allowClientBrowserFallback = false
): boolean {
  if (availability.state !== 'enabled' || workspaceId === FLOATING_TERMINAL_WORKTREE_ID || !route) {
    return false
  }
  const expectedEnvironmentId = expectedRuntimeEnvironmentId.trim()
  const environmentId = route.runtimeEnvironmentId?.trim() || null
  const capabilities = readAppRuntimeStatuses().get(expectedEnvironmentId)?.status?.capabilities
  if (
    environmentId !== expectedEnvironmentId ||
    (!capabilities?.includes(BROWSER_SCREENCAST_RUNTIME_CAPABILITY) &&
      !runtimeHostsPagesOnThisDesktop(state, expectedEnvironmentId) &&
      !(allowClientBrowserFallback && availability.provider === 'local-client'))
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
// desktop: routed through that host when it is eligible for SSH routing, or browsing from this
// device when allowSshDeviceBrowser is set (as new tabs do).
export function isSshDeploymentClientBrowserRoute(
  state: AppState,
  availability: ClientCreationActionAvailability,
  route: ReturnType<typeof resolveWorktreeOperationRoute>,
  workspaceId: string,
  expectedRuntimeEnvironmentId: string,
  allowSshDeviceBrowser = false
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
    (eligibility?.eligible === true || (allowSshDeviceBrowser && eligibility !== null))
  )
}

export function canOpenWorkspaceBrowserTabOnRuntime(
  state: AppState,
  workspaceId: string,
  expectedRuntimeEnvironmentId: string,
  allowSshDeviceBrowser = false
): boolean {
  const availability = getWorkspaceClientCreationActionPolicy(state, workspaceId)['managed-browser']
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
      expectedRuntimeEnvironmentId,
      allowSshDeviceBrowser
    )
  )
}

export function isExpectedSshBrowserRoute(
  state: AppState,
  availability: ClientCreationActionAvailability,
  route: ReturnType<typeof resolveWorktreeOperationRoute>,
  workspaceId: string,
  expectedSshConnectionId: string,
  allowClientBrowserFallback = false
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
    eligibility?.targetId === expectedTargetId &&
    (eligibility.eligible ||
      (allowClientBrowserFallback && availability.provider === 'local-client')) &&
    host?.kind === 'ssh' &&
    host.targetId === expectedTargetId
  )
}

/** Whether a runtime- or SSH-owned link can open in a workspace browser tab. Links that open in
 *  Orca may also use a desktop tab that browses from this device when the SSH host is set to
 *  "This device". */
export function canOpenRemoteLinkInWorkspaceBrowser(
  state: AppState,
  workspaceId: string,
  owner: HttpLinkSourceOwner
): boolean {
  const allowSshDeviceBrowser = state.settings?.openLinksInApp === true
  if (owner.kind === 'runtime') {
    return canOpenWorkspaceBrowserTabOnRuntime(
      state,
      workspaceId,
      owner.runtimeEnvironmentId,
      allowSshDeviceBrowser
    )
  }
  if (owner.kind !== 'ssh') {
    return false
  }
  return isExpectedSshBrowserRoute(
    state,
    getWorkspaceClientCreationActionPolicy(state, workspaceId)['managed-browser'],
    resolveWorktreeOperationRoute(state, workspaceId),
    workspaceId,
    owner.connectionId,
    allowSshDeviceBrowser
  )
}

/** An SSH link whose browser tab is served through that host (eligible SSH routing), so the
 *  host's own localhost is reachable; the "This device" fallback browses from here and is not. */
export function sshLinkRoutesThroughOwnerHost(
  state: AppState,
  workspaceId: string,
  owner: HttpLinkSourceOwner
): boolean {
  return (
    owner.kind === 'ssh' &&
    isExpectedSshBrowserRoute(
      state,
      getWorkspaceClientCreationActionPolicy(state, workspaceId)['managed-browser'],
      resolveWorktreeOperationRoute(state, workspaceId),
      workspaceId,
      owner.connectionId
    )
  )
}
