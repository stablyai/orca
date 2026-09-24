/** User-authored labels that group workspaces across repos in the sidebar. */
export const MAX_WORKTREE_TAG_LENGTH = 48
export const MAX_WORKTREE_TAGS = 32

/** Trim and collapse inner whitespace; returns '' for anything that is not a usable tag. */
export function normalizeWorktreeTag(raw: unknown): string {
  if (typeof raw !== 'string') {
    return ''
  }
  return raw.trim().replace(/\s+/g, ' ').slice(0, MAX_WORKTREE_TAG_LENGTH).trim()
}

/** Case-insensitive identity, so `Billing` and `billing` are one tag. */
export function worktreeTagKey(tag: string): string {
  return normalizeWorktreeTag(tag).toLocaleLowerCase()
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
    const key = tag.toLocaleLowerCase()
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
