/**
 * Which copy of a workspace something belongs to. Copies on different hosts share one workspace
 * id, so a retained resource and each listed record are resolved from their own evidence: neither
 * borrows the current selection, and a route to one copy never vouches for another copy's record.
 */
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import {
  authorityKey,
  hostAuthorityFromOperationRoute,
  type HostAuthority,
  type HostAuthorityEndpoint
} from '../../../shared/host-authority'
import type { ExecutionHostOwnerMatch } from '../../../shared/worktree-execution-host-resolution'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import type { OpenFile } from '@/store/slices/editor'
import { focusFreeRouteStateOf } from './editor-file-operation-provenance'
import { namedHostForOwnerRef, resolveOwner, resolveOwnerOfRoute } from './resolve-owner'
import { resolveUnstampedRecordHost } from './worktree-operation-catalog-route'
import { resolveExactWorktreeRoute, routeForOwner } from './worktree-owner-route'
import {
  findIndexedDetectedWorktrees,
  findIndexedWorktreeOwners
} from './worktree-runtime-owner-index'
import type {
  WorktreeOperationOwnerRecord,
  WorktreeOperationRouteState
} from './worktree-operation-route'

/** What a retained surface knows about its content's copy: the fields its tab already carries. */
export type WorkspaceResource = Pick<
  OpenFile,
  'runtimeEnvironmentId' | 'externalSshTargetId' | 'operationProvenance'
>

/** A surface with no tab evidence: it may show the sole listed copy, never the selected one. */
export const NO_RESOURCE_EVIDENCE: WorkspaceResource = Object.freeze({})

/** A retained resource, or a selection-bound view (the only kind that reads the selected host). */
export type WorkspaceCopySource = WorkspaceResource | 'selection'

type OwnerMatch = ExecutionHostOwnerMatch<HostAuthority>

function sameEndpoint(a: HostAuthorityEndpoint, b: HostAuthorityEndpoint): boolean {
  return a.kind === 'self'
    ? b.kind === 'self'
    : b.kind === 'environment' && a.environmentId === b.environmentId
}

/** The copy a record belongs to: complete stamps prove it; otherwise its host's evidence decides. */
export function resolveRecordOwner(
  state: WorktreeOperationRouteState,
  record: WorktreeOperationOwnerRecord
): OwnerMatch {
  const route = routeForOwner(record)
  if (route?.runtimeEnvironmentId) {
    // Resolving its host instead would merge rival servers proxying the same SSH target.
    return resolveOwnerOfRoute(state, record.id, route)
  }
  const hostId = record.hostId ?? resolveUnstampedRecordHost(state, record)
  return hostId ? resolveOwner(state, { workspaceId: record.id, hostId }) : { kind: 'missing' }
}

/** A host's copy, also before it lists: an unlisted SSH copy takes its server from repo setup, as its record would. */
export function resolveOwnerOnHost(
  state: WorktreeOperationRouteState,
  workspaceId: string,
  hostId: ExecutionHostId
): OwnerMatch {
  const host = parseExecutionHostId(hostId)
  const onHost = (record: WorktreeOperationOwnerRecord) =>
    parseExecutionHostId(record.hostId)?.id === host?.id
  if (
    host?.kind === 'ssh' &&
    parseWorkspaceKey(workspaceId)?.type !== 'folder' &&
    !findIndexedWorktreeOwners(state.worktreesByRepo, workspaceId).some(onHost) &&
    !findIndexedDetectedWorktrees(state.detectedWorktreesByRepo, workspaceId).some(onHost)
  ) {
    const route = resolveExactWorktreeRoute(state, {
      id: workspaceId,
      repoId: getRepoIdFromWorktreeId(workspaceId),
      hostId: host.id
    })
    return route.kind === 'resolved' ? resolveOwnerOfRoute(state, workspaceId, route.route) : route
  }
  return resolveOwner(state, { workspaceId, hostId })
}

/** The one listed copy that fits, `ambiguous` when several (or an unidentifiable one) might. */
function soleListedCopy(
  state: WorktreeOperationRouteState,
  workspaceId: string,
  fits: (authority: HostAuthority) => boolean
): OwnerMatch {
  const copies = new Map<string, HostAuthority>()
  for (const record of findIndexedWorktreeOwners(state.worktreesByRepo, workspaceId)) {
    const owner = resolveRecordOwner(state, record)
    if (owner.kind === 'ambiguous') {
      return owner
    }
    if (owner.kind === 'resolved' && fits(owner.owner)) {
      copies.set(authorityKey(owner.owner), owner.owner)
    }
  }
  const [only] = copies.values()
  return copies.size > 1
    ? { kind: 'ambiguous' }
    : only
      ? { kind: 'resolved', owner: only }
      : { kind: 'missing' }
}

/** A resource's copy from its tab: captured provenance, else the endpoint (and SSH place) it names. */
function resourceEvidence(
  state: WorktreeOperationRouteState,
  workspaceId: string,
  resource: WorkspaceResource
): HostAuthority | { endpoint?: HostAuthorityEndpoint } {
  const provenance = resource.operationProvenance
  // A child repository's provenance names that repository's host, not this workspace's copy.
  if (provenance && !provenance.childRepo) {
    const { route, authority } = provenance.generation
    if (authority) {
      return authority
    }
    const fromRoute = hostAuthorityFromOperationRoute(route)
    const onHost = route.executionHostId
      ? resolveOwnerOnHost(state, workspaceId, route.executionHostId)
      : null
    // Its own route stays the copy when the catalog now names another server for that host.
    if (
      onHost?.kind === 'resolved' &&
      fromRoute &&
      fromRoute !== 'contradictory' &&
      sameEndpoint(onHost.owner.endpoint, fromRoute.endpoint)
    ) {
      return onHost.owner
    }
    if (fromRoute && fromRoute !== 'contradictory') {
      return fromRoute
    }
  }
  const environmentId = resource.runtimeEnvironmentId?.trim()
  const sshTargetId = resource.externalSshTargetId?.trim()
  if (sshTargetId && !environmentId) {
    return { endpoint: { kind: 'self' }, at: `ssh:${sshTargetId}` }
  }
  // Explicit null is this app; undefined says nothing.
  return environmentId
    ? { endpoint: { kind: 'environment', environmentId } }
    : resource.runtimeEnvironmentId === null
      ? { endpoint: { kind: 'self' } }
      : {}
}

/**
 * The copy a surface shows. Selection-bound views take the selected host's copy (or the sole
 * listed one when none is selected); a retained resource takes its own evidence, completed only
 * by the single listed copy it fits. Unknown and rival copies stay unresolved.
 */
export function resolveSourceCopy(
  state: WorktreeOperationRouteState,
  workspaceId: string,
  source: WorkspaceCopySource
): OwnerMatch {
  if (source === 'selection') {
    const hostId = namedHostForOwnerRef(state, { workspaceId })
    return hostId
      ? resolveOwnerOnHost(state, workspaceId, hostId)
      : soleListedCopy(state, workspaceId, () => true)
  }
  const ownerState = focusFreeRouteStateOf(state)
  const evidence = resourceEvidence(ownerState, workspaceId, source)
  if ('at' in evidence) {
    return { kind: 'resolved', owner: evidence }
  }
  const { endpoint } = evidence
  const fits = (authority: HostAuthority) => !endpoint || sameEndpoint(endpoint, authority.endpoint)
  const listed = soleListedCopy(ownerState, workspaceId, fits)
  // A server's copy not listed yet is that server's own route, with the place its repo names.
  return listed.kind === 'missing' && endpoint?.kind === 'environment'
    ? resolveOwner(ownerState, {
        workspaceId,
        hostId: toRuntimeExecutionHostId(endpoint.environmentId)
      })
    : listed
}

/** The host qualifying a folder workspace's catalog record for this source, or none when unknown. */
export function resolveSourceFolderHost(
  state: WorktreeOperationRouteState,
  workspaceId: string,
  source: WorkspaceCopySource
): ExecutionHostId | undefined {
  if (source === 'selection') {
    return namedHostForOwnerRef(state, { workspaceId }) ?? undefined
  }
  const provenance = source.operationProvenance
  if (provenance && !provenance.childRepo && provenance.generation.route.executionHostId) {
    return provenance.generation.route.executionHostId
  }
  const environmentId = source.runtimeEnvironmentId?.trim()
  return environmentId ? toRuntimeExecutionHostId(environmentId) : undefined
}
