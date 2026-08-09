import type { editor } from 'monaco-editor'
import type { Breakpoint } from '../../../../shared/debug-breakpoint-types'

export const BREAKPOINT_GLYPH_CLASS_NAME = 'orca-breakpoint-glyph'
export const BREAKPOINT_HINT_GLYPH_CLASS_NAME = 'orca-breakpoint-glyph orca-breakpoint-glyph--hint'

type BreakpointGlyphInfo = Pick<Breakpoint, 'verified' | 'condition' | 'hitCondition' | 'logMessage'>

export function getBreakpointGlyphClassName(bp: BreakpointGlyphInfo): string {
  const classes = [BREAKPOINT_GLYPH_CLASS_NAME]
  // Why: a log message wins over a condition when both are set, matching how the DAP adapter treats logMessage as turning the stop into a log-and-continue.
  if (bp.logMessage) {
    classes.push('orca-breakpoint-glyph--logpoint')
  } else if (bp.condition || bp.hitCondition) {
    classes.push('orca-breakpoint-glyph--conditional')
  }
  if (!bp.verified) {
    classes.push('orca-breakpoint-glyph--unverified')
  }
  return classes.join(' ')
}

export function getBreakpointHoverMessage(bp: Breakpoint): string {
  const lines: string[] = []
  if (bp.logMessage) {
    lines.push(`Log message: ${bp.logMessage}`)
  }
  if (bp.condition) {
    lines.push(`Condition: ${bp.condition}`)
  }
  if (bp.hitCondition) {
    lines.push(`Hit count: ${bp.hitCondition}`)
  }
  if (!bp.verified) {
    lines.push('Unverified — will resolve once a debug session starts')
  }
  return lines.length > 0 ? lines.join('\n') : 'Breakpoint'
}

function pointRange(line: number): editor.IModelDeltaDecoration['range'] {
  return { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }
}

// Why: linesDecorationsClassName renders into the always-reserved `lineDecorationsWidth` lane.
// glyphMarginClassName was tried first but Monaco collapses that lane to 0px until a decoration
// claims a lane via the (undocumented-in-practice) glyphMargin.position/persistLane combo, which
// made an empty file's gutter permanently unclickable — verified live in the running app.
export function buildBreakpointDecorations(
  breakpoints: readonly Breakpoint[]
): editor.IModelDeltaDecoration[] {
  return breakpoints.map((bp) => ({
    range: pointRange(bp.line),
    options: {
      linesDecorationsClassName: getBreakpointGlyphClassName(bp),
      linesDecorationsTooltip: getBreakpointHoverMessage(bp)
    }
  }))
}

export function buildBreakpointHintDecoration(line: number): editor.IModelDeltaDecoration {
  return {
    range: pointRange(line),
    options: {
      linesDecorationsClassName: BREAKPOINT_HINT_GLYPH_CLASS_NAME
    }
  }
}
