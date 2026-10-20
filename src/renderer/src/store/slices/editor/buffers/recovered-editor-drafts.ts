import type { RecoveredEditorDraft } from '../../../../../../shared/workspace-session-state-types'
import { getDiskBaselineSignature } from '../../../../../../shared/disk-baseline-signature'

const MAX_RECOVERED_DRAFTS = 20
const MAX_RECOVERED_DRAFT_CHARS = 2 * 1024 * 1024

/** Unique per draft: the same file can be recovered in two workspaces. */
export function recoveredEditorDraftId(draft: RecoveredEditorDraft): string {
  // Why the text's hash: an older build rewriting the session drops `id`.
  return (
    draft.id ??
    JSON.stringify([
      draft.worktreeId,
      draft.filePath,
      draft.recoveredAt,
      getDiskBaselineSignature(draft.draft)
    ])
  )
}

/**
 * Adds drafts. The newest within the cap are kept across restarts; the rest stay for this launch
 * only, still offered in the notice, so a draft is never dropped without the user seeing it.
 */
export function appendRecoveredEditorDrafts(
  existing: readonly RecoveredEditorDraft[],
  added: readonly RecoveredEditorDraft[]
): RecoveredEditorDraft[] {
  const newestFirst = [...existing, ...added].sort((a, b) => b.recoveredAt - a.recoveredAt)
  let chars = 0
  let count = 0
  const kept = newestFirst.map((draft) => {
    const fits =
      count < MAX_RECOVERED_DRAFTS && chars + draft.draft.length <= MAX_RECOVERED_DRAFT_CHARS
    if (!fits) {
      console.warn('[editor] a recovered draft is over the cap; kept for this launch only')
      const { keptForThisLaunchOnly: _flag, ...rest } = draft
      return { ...rest, keptForThisLaunchOnly: true as const }
    }
    count += 1
    chars += draft.draft.length
    const { keptForThisLaunchOnly: _flag, ...rest } = draft
    return rest
  })
  return kept.toReversed()
}

/** Always written (an empty list included) so a stale host partition can't bring one back. */
export function recoveredEditorDraftsSessionField(
  drafts: readonly RecoveredEditorDraft[] | undefined
): { recoveredEditorDrafts: RecoveredEditorDraft[] } {
  const persisted: RecoveredEditorDraft[] = []
  for (const draft of drafts ?? []) {
    if (draft.keptForThisLaunchOnly !== true) {
      persisted.push(draft)
    }
  }
  return { recoveredEditorDrafts: persisted }
}

export function isSameRecoveredEditorDraft(
  a: RecoveredEditorDraft,
  b: RecoveredEditorDraft
): boolean {
  return recoveredEditorDraftId(a) === recoveredEditorDraftId(b)
}
