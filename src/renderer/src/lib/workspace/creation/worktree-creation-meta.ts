import type { WorktreeMeta } from '../../../../../shared/worktree/meta-types'
import { normalizeWorktreeTags } from '../../../../../shared/worktree/metadata/worktree-tags'

/** Metadata the composer writes once a workspace exists; empty when there is nothing to save. */
export function getCreationWorktreeMeta(
  note: string | undefined,
  tags: readonly string[] | undefined
): Partial<WorktreeMeta> {
  const comment = note?.trim() ?? ''
  const normalizedTags = normalizeWorktreeTags(tags)
  return {
    ...(comment ? { comment } : {}),
    ...(normalizedTags.length > 0 ? { tags: normalizedTags } : {})
  }
}
