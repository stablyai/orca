import type { WorktreeMeta } from './meta-types'

/**
 * WorktreeMeta slots whose persisted value is a fixed default on almost every row.
 *
 * `mergeWorktreeMetaForWrite` materializes all of them on creation, so a store with ~1,200
 * workspaces carried ~534 KB of `"field":null` / `"field":false` pairs — 12.6% of the whole file —
 * re-serialized on every debounced save and re-parsed on every launch. They are omitted on
 * serialize and re-filled on load, so in-memory state is byte-identical either way.
 *
 * Only genuinely constant defaults belong here: `instanceId` and `sortOrder` are minted per row
 * and must stay written. Absence is safe for an older build too — every projection out of
 * WorktreeMeta into the `Worktree` the app reads (`mergeWorktree`, `getLinkedWorkItemMetadata`,
 * `folder-workspace-model`, `runtime-folder-workspace`, `runtime-worktree-ps-summaries`) already
 * coerces each of these with `?? null` / `?? false`.
 */
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

/** Serialize-side: drop slots still at their default. Returns the input when nothing is dropped. */
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

/** Same, across a whole metadata map. Returns the input map when no row changed. */
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

/** Load-side inverse, in place. Without it `null` silently becomes `undefined` for any consumer
 *  doing `=== null`, so it must land in the same change as the omission. */
export function fillDefaultWorktreeMetaFields(meta: WorktreeMeta): void {
  for (const field of DEFAULTED_FIELDS) {
    if (meta[field] === undefined) {
      ;(meta as Record<string, unknown>)[field] = WORKTREE_META_PERSISTED_DEFAULTS[field]
    }
  }
}
