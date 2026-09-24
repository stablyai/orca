import {
  compareWorktreeTags,
  normalizeWorktreeTags,
  worktreeTagKey
} from '../../worktree/metadata/worktree-tags'

export const TAG_GROUP_PREFIX = 'tag:'
// Why no `tag:` prefix: a user tag can never collide with the Untagged section.
export const UNTAGGED_GROUP_KEY = 'tag-untagged'

export function getTagGroupKey(tag: string): string {
  return `${TAG_GROUP_PREFIX}${worktreeTagKey(tag)}`
}

/** A tag section's key and the tag's spelling; Untagged has no label, each client names it. */
export type TaggedSection = { key: string; label: string }

/** Every tag section a workspace renders in; untagged workspaces get the Untagged section. */
export function getTagSections(record: { tags?: readonly string[] }): TaggedSection[] {
  const tags = normalizeWorktreeTags(record.tags)
  if (tags.length === 0) {
    return [{ key: UNTAGGED_GROUP_KEY, label: '' }]
  }
  return tags.map((tag) => ({ key: getTagGroupKey(tag), label: tag }))
}

export function getTagGroupKeys(record: { tags?: readonly string[] }): string[] {
  return getTagSections(record).map((section) => section.key)
}

/** Tag sections alphabetically, Untagged last. */
export function compareTagSections(
  left: { key: string; label: string },
  right: { key: string; label: string }
): number {
  if (left.key === UNTAGGED_GROUP_KEY || right.key === UNTAGGED_GROUP_KEY) {
    return Number(left.key === UNTAGGED_GROUP_KEY) - Number(right.key === UNTAGGED_GROUP_KEY)
  }
  return compareWorktreeTags(left.label, right.label)
}
