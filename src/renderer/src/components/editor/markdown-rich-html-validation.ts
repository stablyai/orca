import { MarkdownManager } from '@tiptap/markdown'
import { stripMarkdownCode } from './markdown-code-stripping'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

const MAX_PROBE_TEXT_LENGTH = 50_000
const MAX_PROBE_FRAGMENTS = 1_000

// Probe whole blocks containing supported HTML; unrelated blocks need no second parse.
export function getRichMarkdownHtmlValidationOutput(content: string): string | null {
  try {
    const codec = createRichMarkdownEditorCodec()
    const encoded = encodeRawMarkdownHtmlForRichEditor(content, codec)
    // Every `<!` the codec left untokenized is escaped on save — an unprotected
    // comment, a declaration, or a bare literal alike.
    if (stripMarkdownCode(encoded).includes('<!')) {
      return null
    }
    const { transport } = codec
    const parts: string[] = []
    const fragments: string[] = []
    let start = 0
    let encodedHtmlLength = 0
    while (start < encoded.length) {
      const index = encoded.indexOf(transport.authoredPrefix, start)
      if (index === -1) {
        break
      }
      parts.push(encoded.slice(start, index))
      const source = encoded.slice(index)
      const html = transport.match(source, 'inline-html') ?? transport.match(source, 'block-html')
      if (html) {
        if (!containsOnlyCommentsAndBreaks(html.value)) {
          return null
        }
        parts.push(html.value)
        fragments.push(html.value)
        encodedHtmlLength += html.raw.length
        start = index + html.raw.length
      } else {
        parts.push(transport.authoredPrefix)
        start = index + transport.authoredPrefix.length
      }
    }
    parts.push(encoded.slice(start))
    if (fragments.length === 0 || fragments.length > MAX_PROBE_FRAGMENTS) {
      return null
    }
    // Select whole blocks before registering custom tokenizers that scan document suffixes.
    const probe = codec.marked
      .lexer(encoded)
      .filter((token) => token.raw.includes(transport.authoredPrefix))
      .map((token) => token.raw)
      .join('\n\n')
    if (probe.length - encodedHtmlLength > MAX_PROBE_TEXT_LENGTH) {
      return null
    }
    const extensions = createRichMarkdownExtensions({ codec })
    const markdown = extensions.find((extension) => extension.name === 'markdown')
    if (!markdown) {
      return null
    }
    const manager = new MarkdownManager({
      ...markdown.options,
      extensions
    })
    const parsed = manager.parse(probe)
    const output = manager.serialize(parsed)
    const reopened = manager.parse(encodeRawMarkdownHtmlForRichEditor(output, codec))
    if (JSON.stringify(reopened) !== JSON.stringify(parsed)) {
      return null
    }
    let searchIndex = 0
    for (const fragment of fragments) {
      const index = output.indexOf(fragment, searchIndex)
      if (index === -1) {
        return null
      }
      searchIndex = index + fragment.length
    }
    return parts.join('')
  } catch {
    return null
  }
}

function containsOnlyCommentsAndBreaks(content: string): boolean {
  let index = 0
  while (index < content.length) {
    if (/\s/.test(content[index])) {
      index += 1
      continue
    }
    const breakEnd = content.indexOf('>', index) + 1
    if (breakEnd > index && isHtmlLineBreak(content.slice(index, breakEnd))) {
      index = breakEnd
      continue
    }
    if (!content.startsWith('<!--', index)) {
      return false
    }
    const end = content.indexOf('-->', index + 4)
    if (end === -1) {
      return false
    }
    index = end + 3
  }
  return true
}

function isHtmlLineBreak(fragment: string): boolean {
  return /^<br\s*\/?>$/i.test(fragment)
}
