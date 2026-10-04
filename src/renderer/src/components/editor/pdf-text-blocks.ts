/** A box in any consistent coordinate space (client pixels in the viewer). */
export type TextBox = { left: number; top: number; right: number; bottom: number }

type Line = TextBox & { runs: number[] }

// Runs whose vertical centres sit within this share of a line height are one line.
const SAME_LINE_RATIO = 0.5
// Runs this close horizontally continue one line; a column gutter is wider than a word gap.
const SAME_LINE_GAP_RATIO = 0.8
// A blank gap taller than this share of a line height separates paragraphs (and headings).
const PARAGRAPH_GAP_RATIO = 0.75
// A first-line indent this much wider than the column edge starts a paragraph.
const INDENT_RATIO = 0.6
// A line this much shorter than the column is a paragraph's last line.
const SHORT_LINE_RATIO = 0.6

function height(box: TextBox): number {
  return box.bottom - box.top
}

function groupIntoLines(runs: readonly TextBox[]): Line[] {
  const order = runs.map((_, index) => index).sort((a, b) => runs[a].top - runs[b].top)
  const lines: Line[] = []
  for (const index of order) {
    const run = runs[index]
    const centre = (run.top + run.bottom) / 2
    const line = lines.find(
      (candidate) =>
        Math.abs((candidate.top + candidate.bottom) / 2 - centre) <
          SAME_LINE_RATIO * Math.max(height(candidate), height(run)) &&
        run.left < candidate.right + height(run) * SAME_LINE_GAP_RATIO &&
        run.right > candidate.left - height(run) * SAME_LINE_GAP_RATIO
    )
    if (line) {
      line.left = Math.min(line.left, run.left)
      line.right = Math.max(line.right, run.right)
      line.top = Math.min(line.top, run.top)
      line.bottom = Math.max(line.bottom, run.bottom)
      line.runs.push(index)
    } else {
      // Why: copy fields explicitly; DOMRect's are prototype getters that a spread would drop.
      lines.push({
        left: run.left,
        top: run.top,
        right: run.right,
        bottom: run.bottom,
        runs: [index]
      })
    }
  }
  return lines.sort((a, b) => a.top - b.top)
}

function overlapsHorizontally(a: TextBox, b: TextBox): boolean {
  return a.left < b.right && b.left < a.right
}

/**
 * Indexes of the text runs forming the paragraph around `hitIndex`, the PDF counterpart of
 * Design Mode picking a whole element. pdf.js only exposes runs (about a line each), so lines
 * are grouped by layout: a paragraph breaks at a tall gap, an indented first line, a short
 * last line, or a column change.
 */
export function paragraphRunIndexes(runs: readonly TextBox[], hitIndex: number): number[] {
  const lines = groupIntoLines(runs)
  const hit = lines.find((line) => line.runs.includes(hitIndex))
  if (!hit) {
    return [hitIndex]
  }
  // Walk only this column, so a neighbouring column's line at the same height can't cut it short.
  const column = lines.filter((line) => overlapsHorizontally(line, hit))
  const at = column.indexOf(hit)
  const columnLeft = Math.min(...column.map((line) => line.left))
  const columnWidth = Math.max(...column.map((line) => line.right)) - columnLeft
  const continues = (upper: Line, lower: Line): boolean => {
    const lineHeight = Math.max(height(upper), height(lower))
    return (
      overlapsHorizontally(upper, lower) &&
      lower.top - upper.bottom <= PARAGRAPH_GAP_RATIO * lineHeight &&
      lower.left - columnLeft <= INDENT_RATIO * lineHeight &&
      upper.right - upper.left >= SHORT_LINE_RATIO * columnWidth
    )
  }
  let first = at
  while (first > 0 && continues(column[first - 1], column[first])) {
    first -= 1
  }
  let last = at
  while (last < column.length - 1 && continues(column[last], column[last + 1])) {
    last += 1
  }
  return column
    .slice(first, last + 1)
    .flatMap((line) => line.runs)
    .sort((a, b) => a - b)
}
