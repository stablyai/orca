import {
  MULTI_REPO_WORKSPACE_MAX_MEMBERS,
  MULTI_REPO_WORKSPACE_MIN_MEMBERS
} from '../../../../shared/multi-repo-workspace'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import {
  resolveProjectSetupForHost,
  type ProjectSetupIneligibleReason
} from './resolve-project-setup-for-host'

export function toggleMultiRepoSelection(
  selectedProjectIds: readonly string[],
  projectId: string
): string[] {
  return selectedProjectIds.includes(projectId)
    ? selectedProjectIds.filter((id) => id !== projectId)
    : [...selectedProjectIds, projectId]
}

export function isMultiRepoSelection(selectedProjectIds: readonly string[]): boolean {
  return selectedProjectIds.length >= MULTI_REPO_WORKSPACE_MIN_MEMBERS
}

/** An unselected project cannot be added past the host's member limit. */
export function isMultiRepoSelectionFull(selectedProjectIds: readonly string[]): boolean {
  return selectedProjectIds.length >= MULTI_REPO_WORKSPACE_MAX_MEMBERS
}

export type MultiRepoBranchOverride = { branchName?: string; baseRef?: string }

export type MultiRepoCreateMembersResult =
  | { ok: true; members: { repoId: string; branchName?: string; baseRef?: string }[] }
  | { ok: false; projectId: string; reason: ProjectSetupIneligibleReason | 'mixed_hosts' }

/**
 * Members payload for `multiRepoWorkspaces.create`, in selection order. Blank overrides are dropped
 * so the host applies defaults. Re-resolves every project and refuses to send a member whose setup
 * is not on the workspace host, so the host never has to answer `multi_repo_mixed_hosts`.
 */
export function buildMultiRepoCreateMembers(
  selectedProjectIds: readonly string[],
  hostId: ExecutionHostId,
  setups: readonly ProjectHostSetup[],
  setupOverrides: Readonly<Record<string, string | undefined>>,
  branchOverrides: Readonly<Record<string, MultiRepoBranchOverride | undefined>>
): MultiRepoCreateMembersResult {
  const members: { repoId: string; branchName?: string; baseRef?: string }[] = []
  for (const projectId of selectedProjectIds) {
    const resolution = resolveProjectSetupForHost(
      projectId,
      hostId,
      setups,
      setupOverrides[projectId]
    )
    if (resolution.status === 'unavailable') {
      return { ok: false, projectId, reason: resolution.reason }
    }
    if (resolution.setup.hostId !== hostId) {
      return { ok: false, projectId, reason: 'mixed_hosts' }
    }
    const branchName = branchOverrides[projectId]?.branchName?.trim()
    const baseRef = branchOverrides[projectId]?.baseRef?.trim()
    members.push({
      repoId: resolution.setup.repoId,
      ...(branchName ? { branchName } : {}),
      ...(baseRef ? { baseRef } : {})
    })
  }
  return { ok: true, members }
}

export function countBranchOverrides(
  selectedProjectIds: readonly string[],
  branchOverrides: Readonly<Record<string, MultiRepoBranchOverride | undefined>>,
  name: string
): number {
  const trimmedName = name.trim()
  return selectedProjectIds.filter((projectId) => {
    const branch = branchOverrides[projectId]?.branchName?.trim()
    return Boolean(branch) && branch !== trimmedName
  }).length
}

/** Persisted memory of the last multi-repo create (architecture 2.5, UX 3.3). */
export type LastMultiRepoSet = {
  projectIds: string[]
  /** Consecutive single-project creates since the last multi-repo one; the link clears at 2. */
  singleCreatesSince: number
}

export const LAST_MULTI_REPO_SET_CLEAR_AFTER = 2

export function recordCreateInLastSet(
  previous: LastMultiRepoSet | null,
  createdProjectIds: readonly string[]
): LastMultiRepoSet | null {
  if (isMultiRepoSelection(createdProjectIds)) {
    return { projectIds: [...createdProjectIds], singleCreatesSince: 0 }
  }
  if (!previous) {
    return null
  }
  const singleCreatesSince = previous.singleCreatesSince + 1
  return singleCreatesSince >= LAST_MULTI_REPO_SET_CLEAR_AFTER
    ? null
    : { ...previous, singleCreatesSince }
}

/**
 * Project ids the "Same as last time" link fills, or null when it must stay hidden: only while
 * exactly one project is selected and every remembered project resolves on the workspace host.
 */
export function resolveSameAsLastTime(
  last: LastMultiRepoSet | null,
  selectedProjectIds: readonly string[],
  hostId: ExecutionHostId,
  setups: readonly ProjectHostSetup[]
): string[] | null {
  if (!last || selectedProjectIds.length !== 1 || !isMultiRepoSelection(last.projectIds)) {
    return null
  }
  const allResolve = last.projectIds.every(
    (projectId) => resolveProjectSetupForHost(projectId, hostId, setups).status === 'resolved'
  )
  return allResolve ? [...last.projectIds] : null
}
