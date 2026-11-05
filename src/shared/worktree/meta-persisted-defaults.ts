import type { WorktreeMeta } from './meta-types'

/** Omit constant defaults on disk and restore them on load to avoid repeated null/false pairs. Older projections already coalesce these fields.
 * Keep per-row minted values such as instanceId and sortOrder persisted. */
export const WORKTREE_META_PERSISTED_DEFAULTS = {
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  linkedGitLabMR: null,
  linkedGitLabIssue: null,
  linkedBitbucketPR: null,
  linkedAzureDevOpsPR: null,
  linkedGiteaPR: null,
  linkedWorkItem: null,
  linkedTaskSourceContext: null,
  isArchived: false,
  isPinned: false
} as const satisfies Partial<WorktreeMeta>

type DefaultedField = keyof typeof WORKTREE_META_PERSISTED_DEFAULTS

const DEFAULTED_FIELDS = Object.keys(WORKTREE_META_PERSISTED_DEFAULTS) as DefaultedField[]

/** Drop default-valued fields, preserving input identity when unchanged. */
export function omitDefaultWorktreeMetaFields(meta: WorktreeMeta): WorktreeMeta {
  let compacted: WorktreeMeta | undefined
  for (const field of DEFAULTED_FIELDS) {
    if (meta[field] !== WORKTREE_META_PERSISTED_DEFAULTS[field]) {
      continue
    }
    compacted ??= { ...meta }
    delete (compacted as Record<string, unknown>)[field]
  }
  return compacted ?? meta
}

/** Preserve map identity when no row changes. */
export function omitDefaultWorktreeMetaFieldsInMap<T extends Record<string, WorktreeMeta>>(
  metaById: T
): T {
  let compacted: Record<string, WorktreeMeta> | undefined
  for (const [key, meta] of Object.entries(metaById)) {
    const next = omitDefaultWorktreeMetaFields(meta)
    if (next === meta) {
      continue
    }
    compacted ??= { ...metaById }
    compacted[key] = next
  }
  return (compacted as T | undefined) ?? metaById
}

/** Restore in place on load so === null consumers retain the same semantics as before disk compaction. */
export function fillDefaultWorktreeMetaFields(meta: WorktreeMeta): void {
  for (const field of DEFAULTED_FIELDS) {
    if (meta[field] === undefined) {
      ;(meta as Record<string, unknown>)[field] = WORKTREE_META_PERSISTED_DEFAULTS[field]
    }
  }
}
