/** User-authored labels that group workspaces across repos in the sidebar. */
export const MAX_WORKTREE_TAG_LENGTH = 48
export const MAX_WORKTREE_TAGS = 32

/** Trim and collapse inner whitespace; returns '' for anything that is not a usable tag. */
export function normalizeWorktreeTag(raw: unknown): string {
  if (typeof raw !== 'string') {
    return ''
  }
  const collapsed = raw.trim().replace(/\s+/g, ' ')
  // Why code points: slicing UTF-16 units can split an emoji into a lone surrogate.
  return Array.from(collapsed).slice(0, MAX_WORKTREE_TAG_LENGTH).join('').trim()
}

const TAG_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' })

/** Display order for tags: alphabetical, ignoring case and accents. */
export function compareWorktreeTags(left: string, right: string): number {
  return TAG_COLLATOR.compare(left, right)
}

/** Case-insensitive identity, so `Billing` and `billing` are one tag. */
export function worktreeTagKey(tag: string): string {
  // Why not toLocaleLowerCase: hosts on different locales (e.g. Turkish I) must agree on identity.
  return normalizeWorktreeTag(tag).toLowerCase()
}

/** Canonical tag list: normalized, deduped case-insensitively (first spelling wins), capped. */
export function normalizeWorktreeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const seen = new Set<string>()
  const tags: string[] = []
  for (const entry of raw) {
    const tag = normalizeWorktreeTag(entry)
    const key = tag.toLowerCase()
    if (!tag || seen.has(key)) {
      continue
    }
    seen.add(key)
    tags.push(tag)
    if (tags.length >= MAX_WORKTREE_TAGS) {
      break
    }
  }
  return tags
}

/** Write-side canonical form: an empty list is stored as an absent key, never `[]`. */
export function applyNormalizedWorktreeTags<T extends { tags?: string[] }>(record: T): T {
  if (record.tags === undefined) {
    return record
  }
  const tags = normalizeWorktreeTags(record.tags)
  if (tags.length > 0) {
    record.tags = tags
  } else {
    delete record.tags
  }
  return record
}

export type WorktreeTagChanges = {
  /** Replaces the whole set before add/remove apply. */
  replace?: readonly string[]
  add?: readonly string[]
  remove?: readonly string[]
}

/** Applies add/remove (after an optional replace) to a tag list; removals match case-insensitively. */
export function applyWorktreeTagChanges(
  current: readonly string[] | undefined,
  changes: WorktreeTagChanges
): string[] {
  const removed = new Set((changes.remove ?? []).map(worktreeTagKey))
  return normalizeWorktreeTags(
    [...(changes.replace ?? current ?? []), ...(changes.add ?? [])].filter(
      (tag) => !removed.has(worktreeTagKey(tag))
    )
  )
}
