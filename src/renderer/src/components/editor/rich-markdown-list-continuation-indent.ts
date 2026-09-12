// Why: `9. ` is three columns wide and `10. ` is four, so a continuation line's
// content starts at a column the marker decides, not at a constant offset.
const ORDERED_MARKER = /^(\s*)(\d+)\.(\s+)/

/** Column where an ordered item's content begins, counting its indent and marker. */
export function orderedContentColumn(line: string): number | null {
  const match = line.match(ORDERED_MARKER)
  if (!match) {
    return null
  }
  const [, indent, number, gap] = match
  return indent.length + number.length + 1 + gap.length
}

/**
 * Rewrites each ordered item's continuation lines to the two-column indent the
 * base tokenizer assumes. That tokenizer slices a constant two columns past the
 * item's indent, which strands a space under a two-digit marker and eats real
 * characters once the indent sits below the slice width.
 */
export function normalizeOrderedContinuationIndent(source: string): string {
  const lines = source.split('\n')
  let indent: number | null = null
  let column: number | null = null
  return lines
    .map((line) => {
      const itemColumn = orderedContentColumn(line)
      if (itemColumn !== null) {
        indent = line.match(/^\s*/)?.[0].length ?? 0
        column = itemColumn
        return line
      }
      if (column === null || indent === null || line.trim() === '') {
        return line
      }
      const leading = line.match(/^[ \t]*/)?.[0].length ?? 0
      if (leading === 0) {
        indent = null
        column = null
        return line
      }
      // Why: the tokenizer slices `indent + 2`, so the content has to sit exactly there.
      return `${' '.repeat(indent + 2)}${line.slice(Math.min(column, leading))}`
    })
    .join('\n')
}

/**
 * Re-indents the newlines inside a rendered list item so its continuation lines
 * line up under the item's content column. The serializer applies a list's indent
 * only to sibling children, never to newlines inside the item's own paragraph.
 */
export function applyContinuationIndent(rendered: string, column: number): string {
  return rendered.replace(/\n(?!\n)/g, `\n${' '.repeat(column)}`)
}
