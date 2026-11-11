import type { Worktree } from '../../../../../shared/worktree/types'
import { worktreeOwnerIdentity } from '@/lib/workspace/ownership/workspace-catalog-owner-index'
import { readRecordChanges } from '../../keyed-record-change-reads'

type PresentationRow = Pick<Worktree, 'id' | 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'> &
  Partial<Pick<Worktree, 'isBare' | 'isArchived'>>
type ContentBuckets = Readonly<Record<string, readonly unknown[]>>

export type WorkspacePresentationState<W extends PresentationRow> = {
  worktreesByRepo?: Record<string, readonly W[]>
  detectedWorktreesByRepo?: Record<string, { worktrees: readonly W[] }>
  tabsByWorktree?: ContentBuckets
  unifiedTabsByWorktree?: ContentBuckets
  browserTabsByWorktree?: ContentBuckets
}

const EMPTY_BUCKETS: ContentBuckets = {}
const EMPTY_WORKTREES: Record<string, readonly never[]> = {}
const EMPTY_DETECTED: Record<string, { worktrees: readonly never[] }> = {}

type Membership = { ids: Set<string>; changed: ReadonlySet<string> }

function createContentMembership(onInspectBucket?: (id: string) => void) {
  let previous: ContentBuckets = EMPTY_BUCKETS
  let membership: Membership = { ids: new Set(), changed: new Set() }
  return (source: ContentBuckets): Membership => {
    if (source === previous) {
      return membership
    }
    const changes = readRecordChanges(source, previous)
    const addressed = changes?.kind === 'addressed'
    const keys = addressed ? changes.keys : new Set([...Object.keys(source), ...membership.ids])
    let next = membership.ids
    const changed = new Set<string>()
    for (const id of keys) {
      onInspectBucket?.(id)
      const hasContent = Boolean(source[id]?.length)
      if (next.has(id) === hasContent) {
        continue
      }
      if (next === membership.ids) {
        next = new Set(membership.ids)
      }
      if (hasContent) {
        next.add(id)
      } else {
        next.delete(id)
      }
      changed.add(id)
    }
    previous = source
    if (changed.size) {
      membership = { ids: next, changed }
    }
    return membership
  }
}

function changedRecordKeys(
  source: Readonly<Record<string, unknown>>,
  previous: Readonly<Record<string, unknown>>
): Iterable<string> {
  if (source === previous) {
    return []
  }
  const changes = readRecordChanges(source, previous)
  return changes?.kind === 'addressed'
    ? changes.keys
    : new Set([...Object.keys(source), ...Object.keys(previous)])
}

function rowIdentity(row: PresentationRow): string {
  return `${row.id}\0${worktreeOwnerIdentity(row)}`
}

/** Existing content owns its panes; checkout eligibility only owns new workspace choices. */
export function createWorkspacePresentationSelector<W extends PresentationRow>(options?: {
  onInspectBucket?: (id: string) => void
  onInspectDetectedRow?: (id: string) => void
}) {
  const terminalMembership = createContentMembership(options?.onInspectBucket)
  const unifiedMembership = createContentMembership(options?.onInspectBucket)
  const browserMembership = createContentMembership(options?.onInspectBucket)
  let previousVisible: Record<string, readonly W[]> = EMPTY_WORKTREES
  let previousDetected: NonNullable<WorkspacePresentationState<W>['detectedWorktreesByRepo']> =
    EMPTY_DETECTED
  let previousMembership: readonly Membership[] = []
  const candidatesByRepo = new Map<string, readonly W[]>()
  const repoIdsByWorkspace = new Map<string, Set<string>>()
  const retainedRepoIds = new Set<string>()
  let result: Record<string, readonly W[]> = EMPTY_WORKTREES
  return (state: WorkspacePresentationState<W>): Record<string, readonly W[]> => {
    // Narrow ownership snapshots carry no retained content and must not churn the full-state cache.
    if (!state.tabsByWorktree && !state.unifiedTabsByWorktree && !state.browserTabsByWorktree) {
      return state.worktreesByRepo ?? EMPTY_WORKTREES
    }
    const memberships = [
      terminalMembership(state.tabsByWorktree ?? EMPTY_BUCKETS),
      unifiedMembership(state.unifiedTabsByWorktree ?? EMPTY_BUCKETS),
      browserMembership(state.browserTabsByWorktree ?? EMPTY_BUCKETS)
    ]
    const visible = state.worktreesByRepo ?? EMPTY_WORKTREES
    const detected = state.detectedWorktreesByRepo ?? EMPTY_DETECTED
    if (
      visible === previousVisible &&
      detected === previousDetected &&
      memberships.every((value, index) => value === previousMembership[index])
    ) {
      return result
    }
    const affectedRepos = new Set<string>()
    for (const repoId of changedRecordKeys(detected, previousDetected)) {
      if (detected[repoId] === previousDetected[repoId]) {
        continue
      }
      affectedRepos.add(repoId)
      for (const row of candidatesByRepo.get(repoId) ?? []) {
        const repos = repoIdsByWorkspace.get(row.id)
        repos?.delete(repoId)
        if (!repos?.size) {
          repoIdsByWorkspace.delete(row.id)
        }
      }
      const candidates = (detected[repoId]?.worktrees ?? []).filter((row) => {
        options?.onInspectDetectedRow?.(row.id)
        return !row.isArchived
      })
      if (detected[repoId]) {
        candidatesByRepo.set(repoId, candidates)
      } else {
        candidatesByRepo.delete(repoId)
      }
      for (const row of candidates) {
        const repos = repoIdsByWorkspace.get(row.id) ?? new Set<string>()
        repos.add(repoId)
        repoIdsByWorkspace.set(row.id, repos)
      }
    }
    for (const repoId of changedRecordKeys(visible, previousVisible)) {
      if (visible[repoId] !== previousVisible[repoId]) {
        affectedRepos.add(repoId)
      }
    }
    memberships.forEach((membership, index) => {
      if (membership === previousMembership[index]) {
        return
      }
      for (const id of membership.changed) {
        for (const repoId of repoIdsByWorkspace.get(id) ?? []) {
          affectedRepos.add(repoId)
        }
      }
    })
    let next = result
    for (const repoId of affectedRepos) {
      const listed = visible[repoId]
      const listedIdentities = new Set((listed ?? []).map(rowIdentity))
      const retained = (candidatesByRepo.get(repoId) ?? []).filter(
        (row) =>
          memberships.some((membership) => membership.ids.has(row.id)) &&
          !listedIdentities.has(rowIdentity(row))
      )
      if (retained.length) {
        retainedRepoIds.add(repoId)
      } else {
        retainedRepoIds.delete(repoId)
      }
      const rows = retained.length ? [...(listed ?? []), ...retained] : listed
      const previousRows = result[repoId]
      if (
        rows === previousRows ||
        (rows &&
          previousRows &&
          rows.length === previousRows.length &&
          rows.every((row, index) => row === previousRows[index]))
      ) {
        continue
      }
      if (next === result) {
        next = { ...result }
      }
      if (rows) {
        next[repoId] = rows
      } else {
        delete next[repoId]
      }
    }
    previousVisible = visible
    previousDetected = detected
    previousMembership = memberships
    result = retainedRepoIds.size ? next : visible
    return result
  }
}

const selectPresentation = createWorkspacePresentationSelector<PresentationRow>()

export function selectWorkspacePresentationWorktrees<W extends PresentationRow>(
  state: WorkspacePresentationState<W>
): Record<string, readonly W[]> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the projection only returns rows from these exact catalog snapshots, preserving their caller's row type.
  return selectPresentation(state) as Record<string, readonly W[]>
}
