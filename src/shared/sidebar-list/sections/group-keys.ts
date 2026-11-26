import type { Worktree } from '../../worktree/types'
import { getWorktreeHostIdentity } from '../../worktree/host-qualified-identity'
import { UNGROUPED_PROJECT_GROUP_KEY } from '../../project/groups/project-groups'

import '../../workspace-view/workspace-pr-groups'

export function getProjectGroupHeaderKey(groupId: string | null): string {
  return groupId ? `project-group:${groupId}` : UNGROUPED_PROJECT_GROUP_KEY
}

export const PINNED_GROUP_KEY = 'pinned'

export const BOTS_GROUP_KEY = 'bots'

/** A bot group's fold in the Bots section, by its host-qualified sidebar key. */
export function getBotGroupFoldKey(groupEntryKey: string): string {
  return `bot-group:${groupEntryKey}`
}

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

export const LINEAGE_GROUP_PREFIX = 'lineage:'

export function getLineageGroupKey(worktreeId: string): string {
  return `${LINEAGE_GROUP_PREFIX}${worktreeId}`
}

export function getWorktreeLineageGroupKey(worktree: Pick<Worktree, 'id' | 'hostId'>): string {
  return getLineageGroupKey(worktree.hostId ? getWorktreeHostIdentity(worktree) : worktree.id)
}
