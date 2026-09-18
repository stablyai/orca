import { Extension } from '@tiptap/core'

// Why: CommonMark section 6.6 makes `<` raw HTML only as a complete construct, so a
// bare `<` in prose such as `a <beta` is ordinary text and stays literal.
const ATTRIBUTE =
  '(?:\\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\\s*=\\s*(?:[^\\s"\'=<>`]+|\'[^\']*\'|"[^"]*"))?)*'
// Why: sticky so a candidate matches at its own index without copying the suffix,
// and limited to the tag forms whose end the pattern itself bounds.
const TAG_CONSTRUCT = new RegExp(
  `<(?:[a-zA-Z][a-zA-Z0-9-]*${ATTRIBUTE}\\s*/?>|/[a-zA-Z][a-zA-Z0-9-]*\\s*>)`,
  'y'
)

/** A construct the pattern cannot bound, paired with the text that closes it. */
const DELIMITED_CONSTRUCTS = [
  { open: '<!--', close: '-->' },
  { open: '<![CDATA[', close: ']]>' },
  { open: '<?', close: '?>' }
] as const

const DECLARATION = /<![a-zA-Z]/y
const DECLARATION_CLOSE = '>'

// Why: a `>` in the first column opens a block quote, so it stays encoded there
// even though it is ordinary text anywhere else on the line.
const LINE_START = /(^|\n)[ \t]*$/

type TextEncodingManager = {
  encodeTextForMarkdown: (text: string, node: unknown, parentNode: unknown) => string
}

/**
 * Locates each closing sequence at most once per encode. Searching from every
 * candidate opener would rescan the rest of the text for each one, so a document
 * of repeated incomplete openers costs a pass per opener. A closer found ahead of
 * the current opener still closes it, and a closer absent from one offset is
 * absent from every later one, so both outcomes stay valid as the scan advances.
 */
function createCloserSearch(text: string): (close: string, from: number) => number {
  const found = new Map<string, number>()
  const absentFrom = new Map<string, number>()
  return (close, from) => {
    const missing = absentFrom.get(close)
    if (missing !== undefined && from >= missing) {
      return -1
    }
    const previous = found.get(close)
    if (previous !== undefined && previous >= from) {
      return previous
    }
    const at = text.indexOf(close, from)
    if (at === -1) {
      absentFrom.set(close, from)
      return -1
    }
    found.set(close, at)
    return at
  }
}

/** Whether a complete raw-HTML construct starts at `index`. */
function opensHtmlConstruct(
  text: string,
  index: number,
  findCloser: (close: string, from: number) => number
): boolean {
  for (const { open, close } of DELIMITED_CONSTRUCTS) {
    if (text.startsWith(open, index)) {
      return findCloser(close, index + open.length) !== -1
    }
  }
  DECLARATION.lastIndex = index
  if (DECLARATION.test(text)) {
    return findCloser(DECLARATION_CLOSE, DECLARATION.lastIndex) !== -1
  }
  TAG_CONSTRUCT.lastIndex = index
  return TAG_CONSTRUCT.test(text)
}

/**
 * Escapes a character only where its literal form would change how a CommonMark
 * reader parses the text. A bare `&` and a `<` that opens no tag are ordinary
 * text under CommonMark sections 2.5 and 6.5, so both pass through; the parser
 * decodes `&amp;` and `&quot;` to characters that render identically either way.
 */
export function encodeProseTextForMarkdown(text: string): string {
  const findCloser = createCloserSearch(text)
  let output = ''
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '<' && opensHtmlConstruct(text, index, findCloser)) {
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
