import { beadsGetIssue } from '@/runtime/runtime-beads-client'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'

const TITLE_LOOKUP_TIMEOUT_MS = 5_000

/**
 * A dialog-typed beads id carries no title, so the save payload starts with the
 * id standing in. `bd show` supplies the real one when the repo answers.
 * Best-effort on purpose: bd being missing, uninitialized, unsupported on the
 * host, or just slow must not block a metadata save — the id-as-title link
 * still round-trips through every consumer.
 */
export async function withEnrichedBeadsLinkedWorkItemTitle(
  updates: Partial<WorktreeMeta>
): Promise<Partial<WorktreeMeta>> {
  const item = updates.linkedWorkItem
  const context = updates.linkedTaskSourceContext
  if (!item || item.provider !== 'beads' || !item.beadsIdentifier) {
    return updates
  }
  if (!context || context.provider !== 'beads' || !context.repoId) {
    return updates
  }
  if (item.title !== item.beadsIdentifier) {
    return updates
  }
  try {
    const result = await Promise.race([
      beadsGetIssue(context, { repoId: context.repoId, id: item.beadsIdentifier }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), TITLE_LOOKUP_TIMEOUT_MS))
    ])
    if (result?.issue) {
      // Why: same `<id> <title>` shape the Tasks-page Start flow persists.
      return {
        ...updates,
        linkedWorkItem: { ...item, title: `${result.issue.id} ${result.issue.title}` }
      }
    }
  } catch {
    // Unsupported or unreachable host: keep the id-as-title fallback.
  }
  return updates
}
