import type { AppState } from '@/store/types'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { BROWSER_SCREENCAST_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import {
  getWorkspaceClientCreationActionPolicy,
  runtimeHostsPagesOnThisDesktop,
  type ClientCreationActionAvailability
} from './client-creation-action-policy'
import { resolveWorktreeOperationRoute } from './worktree-operation-route'
import { getExecutionHostIdForWorktree } from './worktree-runtime-owner'
import { resolveSshWorkspaceBrowserRouteEligibility } from './ssh-workspace-browser-route-eligibility'

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
  const capabilities =
    state.runtimeStatusByEnvironmentId?.get(expectedEnvironmentId)?.status?.capabilities
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
// desktop, whose page the SSH-routed browser gate sends through that host (as new tabs do).
export function isSshDeploymentClientBrowserRoute(
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
      expectedRuntimeEnvironmentId
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

export function canOpenWorkspaceBrowserTabOnSsh(
  state: AppState,
  workspaceId: string,
  expectedSshConnectionId: string
): boolean {
  const availability = getWorkspaceClientCreationActionPolicy(state, workspaceId)['managed-browser']
  const route = resolveWorktreeOperationRoute(state, workspaceId)
  return isExpectedSshBrowserRoute(state, availability, route, workspaceId, expectedSshConnectionId)
}
