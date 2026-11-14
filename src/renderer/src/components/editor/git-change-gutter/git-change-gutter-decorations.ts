import type { editor } from 'monaco-editor'
import type { GitChangeHunk } from './git-change-hunks'

const BASE_CLASS = 'orca-git-change-gutter'
// editor.OverviewRulerLane.Left, inlined to keep this module free of a runtime Monaco import.
const OVERVIEW_RULER_LANE_LEFT = 1

/** Resolved colors: Monaco paints the overview ruler on a canvas, which cannot read CSS variables. */
export type GitChangeOverviewRulerColors = Record<GitChangeHunk['kind'], string>

function lineDecoration(
  startLineNumber: number,
  endLineNumber: number,
  modifier: string,
  overviewRulerColor: string
): editor.IModelDeltaDecoration {
  return {
    range: { startLineNumber, startColumn: 1, endLineNumber, endColumn: 1 },
    options: {
      isWholeLine: true,
      linesDecorationsClassName: `${BASE_CLASS} ${BASE_CLASS}-${modifier}`,
      ...(overviewRulerColor
        ? { overviewRuler: { color: overviewRulerColor, position: OVERVIEW_RULER_LANE_LEFT } }
        : {})
    }
  }
}

export function buildGitChangeGutterDecorations(
  hunks: readonly GitChangeHunk[],
  overviewRulerColors: GitChangeOverviewRulerColors
): editor.IModelDeltaDecoration[] {
  return hunks.map((hunk) => {
    const color = overviewRulerColors[hunk.kind]
    if (hunk.kind !== 'deleted') {
      return lineDecoration(hunk.startLine, hunk.endLine, hunk.kind, color)
    }
    // Why: a deletion has no line of its own, so it rides the edge of the line it follows.
    return hunk.startLine === 0
      ? lineDecoration(1, 1, 'deleted-top', color)
      : lineDecoration(hunk.startLine, hunk.startLine, 'deleted', color)
  })
}
