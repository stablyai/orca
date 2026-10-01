import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { normalizeWorktreeTags } from '../../../shared/worktree/worktree-tags'

type MetaWriteResult = { ok: true } | { ok: false; error: string }

/** Saves the composer's note and tags once a workspace exists, reporting any failure. */
export async function persistCreationMetadata(args: {
  worktreeId: string
  workspaceName: string
  note: string | undefined
  tags: readonly string[] | undefined
  write: (worktreeId: string, updates: Partial<WorktreeMeta>) => Promise<MetaWriteResult>
}): Promise<void> {
  const comment = args.note?.trim() ?? ''
  const tags = normalizeWorktreeTags(args.tags)
  // Why separate writes: an older remote refuses `tags`, and that refusal must not take the note with it.
  const results = await Promise.all([
    comment ? args.write(args.worktreeId, { comment }) : null,
    tags.length > 0 ? args.write(args.worktreeId, { tags }) : null
  ])
  const failure = results.find((result) => result !== null && !result.ok)
  if (failure && !failure.ok) {
    toast.error(
      translate(
        'auto.lib.worktreeCreationMeta.saveFailed',
        '{{value0}} was created, but its note or tags could not be saved',
        { value0: args.workspaceName }
      ),
      { description: failure.error }
    )
  }
}

/** Committed tags plus a typed-but-unentered one, as the composer submits them. */
export function withPendingTag(tags: readonly string[], draft: string): string[] {
  return normalizeWorktreeTags([...tags, draft])
}
