import { z } from 'zod'
import type { WorktreeOccurrence } from './worktree-occurrence-plan'
import type { Worktree } from './worktree/types'
import { getWorktreeHostIdentity } from './worktree/host-qualified-identity'

export const PinnedGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  order: z.number().finite()
})
export const PinnedGroupsSchema = z.array(PinnedGroupSchema)
export const PinnedGroupMembershipSchema = z.record(z.string(), z.string())
export type PinnedGroup = z.infer<typeof PinnedGroupSchema>
export type PinnedGroupSettings = {
  pinnedGroups?: PinnedGroup[]
  pinnedGroupByWorktreeIdentity?: Record<string, string>
}

export function getPinnedGroupKey(id: string): string {
  return `pinned-group:${id}`
}

export function getPinnedOccurrenceGroupId(
  occurrence: WorktreeOccurrence<Worktree>,
  settings: PinnedGroupSettings
): string | undefined {
  let root = occurrence
  while (root.parent) {
    root = root.parent
  }
  const id = settings.pinnedGroupByWorktreeIdentity?.[getWorktreeHostIdentity(root.row)]
  return settings.pinnedGroups?.some((group) => group.id === id) ? id : undefined
}
