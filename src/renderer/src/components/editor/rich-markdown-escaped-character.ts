import { Mark } from '@tiptap/core'

// marked's GFM inline escape rule: a backslash before ASCII punctuation.
const ESCAPABLE_CHARACTER_PATTERN = /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/
const ESCAPED_CHARACTER_PATTERN = /^\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/
// Why: the serializer entity-encodes these itself; a backslash in front would survive as literal text.
const ENTITY_ENCODED_CHARACTERS = new Set(['&', '<', '>'])
const MARKER_ATTRIBUTE = 'data-rich-markdown-escaped-character'

export const RICH_MARKDOWN_ESCAPED_CHARACTER_MARK = 'richMarkdownEscapedCharacter'

/**
 * Text that was backslash-escaped in the source. Tiptap's markdown parser has no
 * handler for marked's `escape` token (the character was deleted on load) and its
 * text serializer never re-escapes, so the mark carries the escape through the
 * document and the serializer-fidelity pass writes it back per character.
 */
export const RichMarkdownEscapedCharacter = Mark.create({
  name: RICH_MARKDOWN_ESCAPED_CHARACTER_MARK,
  inclusive: false,
  keepOnSplit: false,

  markdownTokenName: RICH_MARKDOWN_ESCAPED_CHARACTER_MARK,
  markdownTokenizer: {
    name: RICH_MARKDOWN_ESCAPED_CHARACTER_MARK,
    level: 'inline',
    start: (src: string) => src.indexOf('\\'),
    tokenize(src: string) {
      const match = src.match(ESCAPED_CHARACTER_PATTERN)
      if (!match) {
        return undefined
      }
      return { type: RICH_MARKDOWN_ESCAPED_CHARACTER_MARK, raw: match[0], character: match[1] }
    }
  },
  parseMarkdown: (token, helpers) => {
    const character = (token as { character?: string }).character
    if (token.type !== RICH_MARKDOWN_ESCAPED_CHARACTER_MARK || !character) {
      return []
    }
    return helpers.applyMark(RICH_MARKDOWN_ESCAPED_CHARACTER_MARK, [
      { type: 'text', text: character }
    ])
  },
  // Why: a mark's markdown is one prefix for the whole run, so `\*\*` would come out as `\**`;
  // this is only the fallback for a serializer that bypasses getMarkdown.
  renderMarkdown: (node, helpers) => `\\${helpers.renderChildren(node)}`,

  parseHTML() {
    return [{ tag: `span[${MARKER_ATTRIBUTE}]` }]
  },
  renderHTML() {
    return ['span', { [MARKER_ATTRIBUTE]: '' }, 0]
  }
})

/** The source form of escaped-mark text: `\X` per escapable character, bare inside code. */
export function escapedCharacterSourceText(text: string, insideCode: boolean): string {
  if (insideCode) {
    return text
  }
  return Array.from(text)
    .map((character) =>
      ESCAPABLE_CHARACTER_PATTERN.test(character) && !ENTITY_ENCODED_CHARACTERS.has(character)
        ? `\\${character}`
        : character
    )
    .join('')
}
