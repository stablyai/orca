import { formatBlameAnnotation, type GitBlameLine } from '../../../../shared/git-blame'

export const GIT_LINE_BLAME_INLINE_CLASS = 'orca-git-line-blame'

export function buildGitLineBlameWidgetModel(
  line: GitBlameLine,
  modelLineCount: number,
  options: { uncommittedLabel: string; nowMs?: number; endColumn: number }
): { text: string; lineNumber: number; column: number } | null {
  if (line.line < 1 || line.line > modelLineCount || options.endColumn < 1) {
    return null
  }
  return {
    text: formatBlameAnnotation(line, options),
    lineNumber: line.line,
    column: options.endColumn
  }
}
