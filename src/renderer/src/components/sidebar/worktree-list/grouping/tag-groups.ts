import { Tag, Tags } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { TagOrderBy } from '../../../../../../shared/ui-chrome-types'
import { getManualTagRanks } from '../../../../../../shared/worktree/manual-tag-order'
import {
  compareWorktreeTags,
  normalizeWorktreeTags,
  worktreeTagKey
} from '../../../../../../shared/worktree/worktree-tags'
import type { OrderedGroupEntry } from './project-grouping'
import { compareRecentRank, recentRankForEntry } from './section-recent-rank'

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

/**
 * Order tag sections by the user's tag-order preference. Name is alphabetical;
 * Manual follows the persisted tag order with unlisted tags appended
 * alphabetically; Activity ranks each section by its most recent agent
 * activity. Untagged stays last in every mode — it is a catch-all, not a tag.
 */
export function sortTagEntries(
  entries: readonly OrderedGroupEntry[],
  tagOrderBy: TagOrderBy,
  manualTagOrder: readonly string[]
): OrderedGroupEntry[] {
  if (tagOrderBy === 'name') {
    return [...entries].sort(([leftKey, left], [rightKey, right]) =>
      compareTagSections({ key: leftKey, label: left.label }, { key: rightKey, label: right.label })
    )
  }
  const ranks = tagOrderBy === 'manual' ? getManualTagRanks(manualTagOrder) : undefined
  return [...entries].sort((leftEntry, rightEntry) => {
    const [leftKey, left] = leftEntry
    const [rightKey, right] = rightEntry
    if (leftKey === UNTAGGED_GROUP_KEY || rightKey === UNTAGGED_GROUP_KEY) {
      return Number(leftKey === UNTAGGED_GROUP_KEY) - Number(rightKey === UNTAGGED_GROUP_KEY)
    }
    if (ranks) {
      const leftRank = ranks.get(worktreeTagKey(left.label)) ?? Number.POSITIVE_INFINITY
      const rightRank = ranks.get(worktreeTagKey(right.label)) ?? Number.POSITIVE_INFINITY
      if (leftRank !== rightRank) {
        return leftRank - rightRank
      }
    } else {
      const byActivity = compareRecentRank(
        recentRankForEntry(leftEntry),
        recentRankForEntry(rightEntry)
      )
      if (byActivity !== 0) {
        return byActivity
      }
    }
    return compareWorktreeTags(left.label, right.label) || leftKey.localeCompare(rightKey)
  })
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
