import { resolveBrowserLinkSession } from './browser-link-session'
import { createBrowserLinkHostMatcher } from './browser-link-owner'
import type { AppState } from '@/store/types'
import type { HttpLinkGroupActionRequest } from './http-link-routing'
import { captureLinkOpenIntent } from './link-open-intent'
import { getWorkspaceClientCreationActionPolicy } from './client-creation-action-policy'
import {
  getFloatingWorkspaceOperationRoute,
  resolveWorktreeOperationRoute
} from './worktree-operation-route'
import {
  isExpectedRuntimeBrowserRoute,
  isSshDeploymentClientBrowserRoute,
  isExpectedSshBrowserRoute
} from './workspace-browser-route-eligibility'
import { selectBrowserLinkDestination } from './browser-link-destination'
import { parseExecutionHostId, toRuntimeExecutionHostId } from '../../../shared/execution-host'

/** Strict local creation is supported; an unproven runtime route can only reuse a pinned match. */
export function canOfferHttpLinkGroupAction(
  state: AppState,
  request: HttpLinkGroupActionRequest
): boolean {
  const availability = getWorkspaceClientCreationActionPolicy(state, request.workspaceId)[
    'managed-browser'
  ]
  const route =
    getFloatingWorkspaceOperationRoute(request.workspaceId) ??
    resolveWorktreeOperationRoute(state, request.workspaceId)
  const intent = captureLinkOpenIntent(state, request.workspaceId, request.sourceTabId, {
    explicitSourceGroup: true
  })
  if (
    !intent?.targetGroupId ||
    !route?.executionHostId ||
    !createBrowserLinkHostMatcher(
      state,
      request.workspaceId,
      route.executionHostId
    )(intent.hostId) ||
    availability.state !== 'enabled'
  ) {
    return false
  }
  const owner = request.sourceOwner
  if (owner?.kind === 'unknown') {
    return false
  }
  if (owner?.kind === 'ssh') {
    return isExpectedSshBrowserRoute(
      state,
      availability,
      route,
      request.workspaceId,
      owner.connectionId
    )
  }
  if (owner?.kind !== 'runtime') {
    return parseExecutionHostId(route.executionHostId)?.kind !== 'runtime'
  }
  if (
    isSshDeploymentClientBrowserRoute(
      state,
      availability,
      route,
      request.workspaceId,
      owner.runtimeEnvironmentId
    )
  ) {
    return true
  }
  if (
    !request.url ||
    !isExpectedRuntimeBrowserRoute(
      state,
      availability,
      route,
      request.workspaceId,
      owner.runtimeEnvironmentId
    )
  ) {
    return false
  }
  const profileHostId = toRuntimeExecutionHostId(owner.runtimeEnvironmentId)
  const selection = selectBrowserLinkDestination(
    state,
    {
      worktreeId: request.workspaceId,
      executionHostId: route.executionHostId,
      browserRuntimeEnvironmentId: owner.runtimeEnvironmentId,
      profileHostId,
      ...resolveBrowserLinkSession(state, request.workspaceId, profileHostId),
      resource: { kind: 'website', url: request.url }
    },
    intent
  )
  return selection.status === 'ready' && selection.match !== null
}
