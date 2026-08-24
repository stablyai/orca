import type { DecoratedDiffComment } from '../diff-comments/decorated-diff-comment'

// Why: ```suggestion previews need the current text of the commented range;
// only threads that actually carry a suggestion pay for the line slicing.
export function enrichInlineCommentsWithSuggestionTargets(
  inlineComments: readonly DecoratedDiffComment[] | undefined,
  section: { path: string; modifiedContent: string | null }
): readonly DecoratedDiffComment[] | undefined {
  const modifiedContent = section.modifiedContent
  if (!inlineComments || !modifiedContent) {
    return inlineComments
  }
  let lines: string[] | null = null
  return inlineComments.map((comment) => {
    if (!comment.reviewThread || comment.filePath !== section.path) {
      return comment
    }
    const hasSuggestion =
      comment.body.includes('```suggestion') ||
      comment.reviewThread.replies.some((reply) => reply.body.includes('```suggestion'))
    // Why: LEFT-side threads anchor to the base file; head-buffer lines do not correspond.
    if (!hasSuggestion || comment.reviewThread.diffSide === 'LEFT') {
      return comment
    }
    lines ??= modifiedContent.split('\n')
    const start = (comment.startLine ?? comment.lineNumber) - 1
    const end = comment.lineNumber
    if (start < 0 || end > lines.length) {
      return comment
    }
    return { ...comment, suggestionTargetLines: lines.slice(start, end) }
  })
}
