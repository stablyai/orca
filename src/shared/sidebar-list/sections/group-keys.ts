import type { Worktree } from '../../worktree/types'
import { getWorktreeHostIdentity } from '../../worktree/host-qualified-identity'
import { UNGROUPED_PROJECT_GROUP_KEY } from '../../project/groups/project-groups'

import '../../workspace-view/workspace-pr-groups'

export function getProjectGroupHeaderKey(groupId: string | null): string {
  return groupId ? `project-group:${groupId}` : UNGROUPED_PROJECT_GROUP_KEY
}

export const PINNED_GROUP_KEY = 'pinned'

export const BOTS_GROUP_KEY = 'bots'

/** The whole Projects section, foldable while the Bots section sits above it. */
export const PROJECTS_SECTION_GROUP_KEY = 'projects-section'

/** Repo, project, and project-group headers; never status, PR, pinned, lineage, or host sections. */
export function isProjectSectionGroupKey(key: string): boolean {
  return key.startsWith('repo:') || key.startsWith('project:') || key.startsWith('project-group:')
}

export function isProjectOrPinnedSectionGroupKey(key: string): boolean {
  return key === PINNED_GROUP_KEY || isProjectSectionGroupKey(key)
}

export const ALL_GROUP_KEY = 'all'

/** Section headers owned by a single `groupBy` mode; never top-level sections, pinned, lineage, or hosts. */
export function isGroupByModeSectionKey(key: string): boolean {
  return (
    isProjectSectionGroupKey(key) ||
    key === ALL_GROUP_KEY ||
    key.startsWith(`${ALL_GROUP_KEY}:host:`) ||
    key.startsWith('workspace-status:') ||
    key.startsWith('pr:')
  )
}

/** Drops mode-specific section folds while preserving orthogonal folds (Bots, Projects, hosts, pinned, lineage). */
export function clearGroupByModeCollapsedGroups(collapsedGroups: Set<string>): Set<string> {
  let hasModeKey = false
  for (const key of collapsedGroups) {
    if (isGroupByModeSectionKey(key)) {
      hasModeKey = true
      break
    }
  }
  if (!hasModeKey) {
    return collapsedGroups
  }
  const next = new Set<string>()
  for (const key of collapsedGroups) {
    if (!isGroupByModeSectionKey(key)) {
      next.add(key)
    }
  }
  return next
}

export const LINEAGE_GROUP_PREFIX = 'lineage:'

export function getLineageGroupKey(worktreeId: string): string {
  return `${LINEAGE_GROUP_PREFIX}${worktreeId}`
}

export function getWorktreeLineageGroupKey(worktree: Pick<Worktree, 'id' | 'hostId'>): string {
  return getLineageGroupKey(worktree.hostId ? getWorktreeHostIdentity(worktree) : worktree.id)
}
