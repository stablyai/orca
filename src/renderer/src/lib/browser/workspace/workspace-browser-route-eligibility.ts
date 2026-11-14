import { parseExecutionHostId } from '../../../../../shared/execution-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/constants'
import '../../../../../shared/protocol-version'
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

// SSH deployments use this desktop's browser even when their network traffic stays on this device.
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
    eligibility !== null
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
    eligibility?.targetId === expectedTargetId &&
    (eligibility.eligible || availability.provider === 'local-client') &&
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
