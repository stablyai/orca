import type { DiffComment } from '../../../shared/diff-comment-types'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { isMarkdownComment } from './diff-comment-compat'

export function isMarkdownReviewNotesEnabled(
  settings: Pick<GlobalSettings, 'markdownReviewToolsEnabled'> | null | undefined
): boolean {
  // Why: settings hydrate async; only an explicit off hides notes, so they never flicker on launch.
  return settings?.markdownReviewToolsEnabled !== false
}

/** Returns the input array itself when nothing is removed, keeping memoized consumers stable. */
export function withoutMarkdownReviewNotes(comments: DiffComment[]): DiffComment[] {
  return comments.some(isMarkdownComment)
    ? comments.filter((comment) => !isMarkdownComment(comment))
    : comments
}
