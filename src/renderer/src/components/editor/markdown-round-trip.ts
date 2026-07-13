import { Editor } from '@tiptap/core'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { createRichMarkdownHtmlSuperscriptLinkContext } from './rich-markdown-html-superscript-link-context'

const roundTripCache = new Map<string, string | null>()
const MAX_CACHE_ENTRIES = 20

export function canRoundTripRichMarkdown(content: string): boolean {
  const output = getRichMarkdownRoundTripOutput(content)
  return output !== null && normalizeMarkdown(content) === normalizeMarkdown(output)
}

export function getRichMarkdownRoundTripOutput(content: string): string | null {
  const cached = roundTripCache.get(content)
  if (cached !== undefined) {
    return cached
  }

  let output: string | null = null

  try {
    const codec = createRichMarkdownEditorCodec()
    const context = createRichMarkdownHtmlSuperscriptLinkContext({
      sourceFilePath: '',
      worktreeId: '',
      worktreeRoot: null,
      sourceOwner: { kind: 'unknown' }
    })
    const editor = new Editor({
      element: null,
      extensions: createRichMarkdownExtensions({
        codec,
        htmlSuperscriptLinks: true,
        htmlSuperscriptLinkContext: context
      }),
      content: encodeRawMarkdownHtmlForRichEditor(content, codec, {
        htmlSuperscriptLinks: true
      }),
      contentType: 'markdown'
    })
    try {
      output = editor.getMarkdown()
    } finally {
      editor.destroy()
    }
  } catch {
    output = null
  }

  roundTripCache.set(content, output)
  if (roundTripCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = roundTripCache.keys().next().value
    if (oldestKey) {
      roundTripCache.delete(oldestKey)
    }
  }

  return output
}

function normalizeMarkdown(content: string): string {
  return content.replace(/\r\n/g, '\n').trimEnd()
}
