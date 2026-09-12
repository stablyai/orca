/**
 * Re-indents the newlines inside a rendered list item so its continuation lines
 * line up under the item's content column. The serializer applies a list's indent
 * only to sibling children, never to newlines inside the item's own paragraph.
 */
export function applyContinuationIndent(rendered: string, column: number): string {
  return rendered.replace(/\n(?!\n)/g, `\n${' '.repeat(column)}`)
}
