import type { Processor } from 'unified'

/**
 * Stop the parser from reading `[label]: /some/target` (and its GFM footnote
 * sibling `[^label]: text`) as a definition.
 *
 * A definition renders to nothing at all, so on content that is prose rather
 * than authored Markdown — a chat turn the user typed — such a line silently
 * deletes itself. Escaping the bracket in the source text only reaches lines at
 * the top level; a definition inside a list item or blockquote, or one whose
 * label wraps across lines, is still swallowed. Turning the constructs off
 * covers every container without rewriting a byte of what the user wrote.
 *
 * Inline links and the rest of GFM are untouched. Reference links necessarily
 * render literally, because they resolve *against* the definitions this removes
 * — which is the right reading for prose, where `[d]` is far more likely to be
 * a bracket the user typed than a link they meant to define.
 */
export function remarkDisableDefinitions(this: Processor): undefined {
  const data = this.data()
  const extensions = (data.micromarkExtensions ??= [])
  extensions.push({ disable: { null: ['definition', 'gfmFootnoteDefinition'] } })
  return undefined
}
