import { Extension } from '@tiptap/core'

// Why: only an open tag, a close tag, or a comment makes `<` raw HTML rather than text.
const TAG_OPENING = /^<(?:[a-zA-Z][a-zA-Z0-9-]*|\/[a-zA-Z][a-zA-Z0-9-]*|!--)/

// Why: a `>` in the first column opens a block quote, so it stays encoded there
// even though it is ordinary text anywhere else on the line.
const LINE_START = /(^|\n)[ \t]*$/

type TextEncodingManager = {
  encodeTextForMarkdown: (text: string, node: unknown, parentNode: unknown) => string
}

/**
 * Escapes a character only where its literal form would change how a CommonMark
 * reader parses the text. A bare `&` and a `<` that opens no tag are ordinary
 * text under CommonMark sections 2.5 and 6.5, so both pass through; the parser
 * decodes `&amp;` and `&quot;` to characters that render identically either way.
 */
export function encodeProseTextForMarkdown(text: string): string {
  let output = ''
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '<' && TAG_OPENING.test(text.slice(index))) {
      output += '&lt;'
      continue
    }
    if (character === '>' && LINE_START.test(output)) {
      output += '&gt;'
      continue
    }
    output += character
  }
  return output
}

/**
 * Replaces the markdown manager's text encoder so prose keeps its literal
 * characters. Registered at the lowest priority so it runs after `Markdown`
 * publishes the manager on the editor.
 */
export const RichMarkdownProseEntities = Extension.create({
  name: 'richMarkdownProseEntities',
  priority: 1,

  onBeforeCreate() {
    const manager = (this.editor as unknown as { markdown?: TextEncodingManager }).markdown
    if (!manager) {
      return
    }
    const base = manager.encodeTextForMarkdown.bind(manager)
    manager.encodeTextForMarkdown = (text, node, parentNode) => {
      // Why: the base encoder returns code-context text unchanged, which is the only
      // signal available here that literal characters are already correct.
      const encoded = base(text, node, parentNode)
      return encoded === text ? text : encodeProseTextForMarkdown(text)
    }
  }
})
