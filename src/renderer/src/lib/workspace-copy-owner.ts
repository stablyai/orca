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
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaceCopies,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'
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

/** What a source proves: a whole copy, or only its endpoint (explicit null is this app; none is unknown). */
type SourceEvidence =
  | { kind: 'authority'; authority: HostAuthority }
  | { kind: 'endpoint'; endpoint?: HostAuthorityEndpoint }

const UNKNOWN_SOURCE: SourceEvidence = { kind: 'endpoint' }

function fitsEvidence(evidence: SourceEvidence, authority: HostAuthority): boolean {
  return evidence.kind === 'authority'
    ? authorityKey(authority) === authorityKey(evidence.authority)
    : !evidence.endpoint || sameEndpoint(evidence.endpoint, authority.endpoint)
}

/** Stable spelling of the evidence, so readers of one source share qualification. */
function evidenceKey(evidence: SourceEvidence): string {
  return evidence.kind === 'authority'
    ? `a:${authorityKey(evidence.authority)}`
    : evidence.endpoint?.kind === 'environment'
      ? `e:${evidence.endpoint.environmentId}`
      : evidence.endpoint
        ? 's'
        : 'u'
}

function sameEndpoint(a: HostAuthorityEndpoint, b: HostAuthorityEndpoint): boolean {
  return a.kind === 'self'
    ? b.kind === 'self'
    : b.kind === 'environment' && a.environmentId === b.environmentId
}

type CatalogMemo<R> = WeakMap<object, { inputs: readonly unknown[]; results: Map<string, R> }>

/** One result per key while the anchor snapshot and inputs stay the same, shared by every reader of that snapshot. */
function memoOnCatalog<R>(
  cache: CatalogMemo<R>,
  anchor: object,
  inputs: readonly unknown[],
  key: string,
  compute: () => R
): R {
  let cached = cache.get(anchor)
  if (!cached || cached.inputs.some((input, index) => !Object.is(input, inputs[index]))) {
    cached = { inputs, results: new Map() }
    cache.set(anchor, cached)
  }
  let result = cached.results.get(key)
  if (!result) {
    result = compute()
    cached.results.set(key, result)
  }
  return result
}

// Rows of one workspace on one host share an answer; resolving each row would rescan its same-id peers.
const recordOwnerCache: CatalogMemo<OwnerMatch> = new WeakMap()

/** The copy a record belongs to: complete stamps prove it; otherwise its host's evidence decides. */
export function resolveRecordOwner(
  state: WorktreeOperationRouteState,
  record: WorktreeOperationOwnerRecord
): OwnerMatch {
  const route = routeForOwner(record)
  const stamped = route?.runtimeEnvironmentId ? route : null
  const hostId = stamped ? null : (record.hostId ?? resolveUnstampedRecordHost(state, record))
  const compute = (): OwnerMatch =>
    stamped
      ? // Resolving its host instead would merge rival servers proxying the same SSH target.
        resolveOwnerOfRoute(state, record.id, stamped)
      : hostId
        ? resolveOwner(state, { workspaceId: record.id, hostId })
        : { kind: 'missing' }
  const rows = selectWorktreesByRepo(state)
  if (!rows) {
    return compute()
  }
  const key = stamped
    ? `r\0${record.id}\0${stamped.executionHostId ?? ''}\0${stamped.runtimeEnvironmentId}`
    : `h\0${record.id}\0${hostId ?? ''}`
  const inputs = [selectDetectedWorktreesByRepo(state), state.repos, state.runtimeEnvironments]
  return memoOnCatalog(recordOwnerCache, rows, inputs, key, compute)
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
    !findIndexedWorktreeOwners(selectWorktreesByRepo(state), workspaceId).some(onHost) &&
    !findIndexedDetectedWorktrees(selectDetectedWorktreesByRepo(state), workspaceId).some(onHost)
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
  for (const record of findIndexedWorktreeOwners(selectWorktreesByRepo(state), workspaceId)) {
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
): SourceEvidence {
  const provenance = resource.operationProvenance
  // A child repository's provenance names that repository's host, not this workspace's copy.
  if (provenance && !provenance.childRepo) {
    const { route, authority } = provenance.generation
    if (authority) {
      return { kind: 'authority', authority }
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
      return { kind: 'authority', authority: onHost.owner }
    }
    if (fromRoute && fromRoute !== 'contradictory') {
      return { kind: 'authority', authority: fromRoute }
    }
  }
  const environmentId = resource.runtimeEnvironmentId?.trim()
  const sshTargetId = resource.externalSshTargetId?.trim()
  if (sshTargetId && !environmentId) {
    return {
      kind: 'authority',
      authority: { endpoint: { kind: 'self' }, at: `ssh:${sshTargetId}` }
    }
  }
  // Explicit null is this app; undefined says nothing.
  return environmentId
    ? { kind: 'endpoint', endpoint: { kind: 'environment', environmentId } }
    : resource.runtimeEnvironmentId === null
      ? { kind: 'endpoint', endpoint: { kind: 'self' } }
      : UNKNOWN_SOURCE
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
  if (evidence.kind === 'authority') {
    return { kind: 'resolved', owner: evidence.authority }
  }
  const { endpoint } = evidence
  const listed = soleListedCopy(ownerState, workspaceId, (authority) =>
    fitsEvidence(evidence, authority)
  )
  // A server's copy not listed yet is that server's own route, with the place its repo names.
  return listed.kind === 'missing' && endpoint?.kind === 'environment'
    ? resolveOwner(ownerState, {
        workspaceId,
        hostId: toRuntimeExecutionHostId(endpoint.environmentId)
      })
    : listed
}

/**
 * The host qualifying the folder catalog record a source shows, by the same evidence and
 * resolver as worktree copies: each catalog record's owner, filtered by what the source proves.
 */
export function resolveSourceFolderHost(
  state: WorktreeOperationRouteState,
  workspaceId: string,
  folderWorkspaceId: string,
  source: WorkspaceCopySource
): ExecutionHostOwnerMatch<ExecutionHostId | undefined> {
  const named = source === 'selection' ? namedHostForOwnerRef(state, { workspaceId }) : null
  if (named) {
    return { kind: 'resolved', owner: named }
  }
  const ownerState = source === 'selection' ? state : focusFreeRouteStateOf(state)
  // A file outside the folder names its own SSH target, not the folder catalog's host.
  const evidence =
    source === 'selection'
      ? UNKNOWN_SOURCE
      : resourceEvidence(ownerState, workspaceId, { ...source, externalSshTargetId: undefined })
  const copies = selectFolderWorkspaceCopies(ownerState, folderWorkspaceId)
  // An absent folder has nothing to qualify; caching it would key on a shared empty list forever.
  if (copies.length === 0) {
    return NO_FOLDER_COPY
  }
  return memoOnCatalog(
    folderQualificationCache,
    copies,
    FOLDER_OWNER_INPUTS.map((key) => ownerState[key]),
    `${workspaceId}\0${evidenceKey(evidence)}`,
    () => qualifyFolderCopies(ownerState, workspaceId, copies, evidence)
  )
}

const NO_FOLDER_COPY: FolderQualification = { kind: 'missing' }

/** Every catalog input a folder copy's owner is resolved from, besides the copies themselves. */
const FOLDER_OWNER_INPUTS = [
  'projectGroups',
  'repos',
  'runtimeEnvironments',
  'settings',
  'restoredRuntimeHostIdByWorkspaceSessionKey',
  'runtimeEnvironmentCatalogHydrated',
  'removedRuntimeEnvironmentIds'
] as const satisfies readonly (keyof WorktreeOperationRouteState)[]

type FolderQualification = ExecutionHostOwnerMatch<ExecutionHostId | undefined>

// Keyed by one id's copies from the folder index, so readers of that folder and evidence share the result until its catalog changes.
const folderQualificationCache: CatalogMemo<FolderQualification> = new WeakMap()

function qualifyFolderCopies(
  state: WorktreeOperationRouteState,
  workspaceId: string,
  copies: readonly { executionHostId?: string | null }[],
  evidence: SourceEvidence
): FolderQualification {
  const hosts = new Set(copies.map((copy) => parseExecutionHostId(copy.executionHostId)?.id))
  const fitting = new Map<string, ExecutionHostId | undefined>()
  for (const hostId of hosts) {
    const owner = resolveOwner(state, { workspaceId, ...(hostId ? { hostId } : {}) })
    if (owner.kind === 'ambiguous') {
      return owner
    }
    if (owner.kind === 'resolved' && fitsEvidence(evidence, owner.owner)) {
      fitting.set(authorityKey(owner.owner), hostId)
    }
  }
  const [only] = fitting.entries()
  return fitting.size > 1
    ? { kind: 'ambiguous' }
    : only
      ? { kind: 'resolved', owner: only[1] }
      : { kind: 'missing' }
}
