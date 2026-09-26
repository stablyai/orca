import { Tag, Tags } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import {
  compareWorktreeTags,
  normalizeWorktreeTags,
  worktreeTagKey
} from '../../../../../../shared/worktree/worktree-tags'

export const TAG_GROUP_PREFIX = 'tag:'
// Why no `tag:` prefix: a user tag can never collide with the Untagged section.
export const UNTAGGED_GROUP_KEY = 'tag-untagged'

export const TAG_GROUP_META = {
  tone: 'text-foreground',
  icon: Tag
} as const

export const UNTAGGED_GROUP_META = {
  get label() {
    return translate('auto.components.sidebar.worktree.list.groups.untagged', 'Untagged')
  },
  tone: 'text-muted-foreground',
  icon: Tags
} as const

export function getTagGroupKey(tag: string): string {
  return `${TAG_GROUP_PREFIX}${worktreeTagKey(tag)}`
}

export type TaggedSection = { key: string; label: string }

/** Every tag section a workspace renders in; untagged workspaces get the Untagged section. */
export function getTagSections(record: { tags?: readonly string[] }): TaggedSection[] {
  const tags = normalizeWorktreeTags(record.tags)
  if (tags.length === 0) {
    return [{ key: UNTAGGED_GROUP_KEY, label: UNTAGGED_GROUP_META.label }]
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
  return compareWorktreeTags(left.label, right.label) || left.key.localeCompare(right.key)
}

function isTagSectionKey(key: string): boolean {
  return key.startsWith(TAG_GROUP_PREFIX) || key === UNTAGGED_GROUP_KEY
}

/** Reveal keys with at most one tag section: none if one is already open, else the first. */
export function narrowTagRevealKeys(
  keys: readonly string[],
  collapsedGroups: ReadonlySet<string>
): string[] {
  const tagKeys = keys.filter(isTagSectionKey)
  const otherKeys = keys.filter((key) => !isTagSectionKey(key))
  if (tagKeys.length === 0 || tagKeys.some((key) => !collapsedGroups.has(key))) {
    return otherKeys
  }
  const [first] = [...tagKeys].sort((left, right) => compareWorktreeTags(left, right))
  return [...otherKeys, first]
}
