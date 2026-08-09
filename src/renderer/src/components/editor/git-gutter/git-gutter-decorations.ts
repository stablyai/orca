import type { editor } from 'monaco-editor'
import type { GitGutterHunk } from './git-gutter-line-diff'

const BASE_CLASS = 'orca-git-gutter'

function wholeLineDecoration(
  startLineNumber: number,
  endLineNumber: number,
  className: string
): editor.IModelDeltaDecoration {
  return {
    range: { startLineNumber, startColumn: 1, endLineNumber, endColumn: 1 },
    options: { isWholeLine: true, linesDecorationsClassName: className }
  }
}

export function buildGitGutterDecorations(
  hunks: readonly GitGutterHunk[]
): editor.IModelDeltaDecoration[] {
  return hunks.flatMap((hunk) => {
    if (hunk.kind === 'deleted') {
      // Why: the wedge sits between two lines, so it rides the bottom edge of the line above —
      // except at the top of the file, where there is no line above to hang it on.
      const anchorsAboveFirstLine = hunk.afterLine <= 0
      const className = anchorsAboveFirstLine
        ? `${BASE_CLASS} ${BASE_CLASS}-deleted ${BASE_CLASS}-deleted-top`
        : `${BASE_CLASS} ${BASE_CLASS}-deleted`
      const line = anchorsAboveFirstLine ? 1 : hunk.afterLine
      return [wholeLineDecoration(line, line, className)]
    }
    if (hunk.startLine < 1 || hunk.endLine < hunk.startLine) {
      return []
    }
    return [
      wholeLineDecoration(hunk.startLine, hunk.endLine, `${BASE_CLASS} ${BASE_CLASS}-${hunk.kind}`)
    ]
  })
}
