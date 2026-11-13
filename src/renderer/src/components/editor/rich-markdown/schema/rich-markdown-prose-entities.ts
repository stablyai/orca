import type { Editor, JSONContent } from '@tiptap/core'

// Literal `&` only parses differently before an entity name, `<` unless spaced (HTML, autolinks, MDX JSX), and `>` at a
// block-quote position or inside a bare URL; a `>` after a space that follows no list marker is neither.
const REDUNDANT_ENTITY = /&amp;(?!#?[A-Za-z0-9]+;|$)|&lt;(?=[ \t])|(?<=[^\s*+\-.)][ \t]+)&gt;/g
const LITERAL_BY_ENTITY: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>' }

/** Keep typed `&`, `<` and `>` literal where encoding them cannot change how the Markdown parses. */
export function preserveLiteralProseEntities(editor: Editor): void {
  const manager = editor.markdown!
  // Depends on @tiptap/markdown's private per-text-node encoder; recheck on upgrade.
  const encode: (text: string, node: JSONContent, parentNode?: JSONContent) => string =
    manager['encodeTextForMarkdown'].bind(manager)
  manager['encodeTextForMarkdown'] = (
    text: string,
    node: JSONContent,
    parentNode?: JSONContent
  ): string => {
    const encoded = encode(text, node, parentNode)
    // Unchanged output covers code, whose literal entity text must not be decoded.
    return encoded === text
      ? encoded
      : encoded.replace(REDUNDANT_ENTITY, (entity) => LITERAL_BY_ENTITY[entity])
  }
}
