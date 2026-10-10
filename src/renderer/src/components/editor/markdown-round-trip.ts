import { Editor, getSchema } from '@tiptap/core'
import { MarkdownManager } from '@tiptap/markdown'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import {
  createRichMarkdownEditorCodec,
  type RichMarkdownEditorCodec
} from './rich-markdown-source-transport'
import { createRichMarkdownHtmlSuperscriptLinkContext } from './rich-markdown-html-superscript-link-context'

const roundTripCache = new Map<string, string | null>()
const MAX_CACHE_ENTRIES = 20

function createRoundTripExtensions(codec: RichMarkdownEditorCodec) {
  return createRichMarkdownExtensions({
    codec,
    htmlSuperscriptLinks: true,
    htmlSuperscriptLinkContext: createRichMarkdownHtmlSuperscriptLinkContext({
      sourceFilePath: '',
      worktreeId: '',
      worktreeRoot: null,
      sourceOwner: { kind: 'unknown' }
    })
  })
}

/** Validate encoded passthrough markup with the production parser, without an EditorView. */
export function getRichMarkdownPassthroughOutput(
  encoded: string,
  codec: RichMarkdownEditorCodec
): string | null {
  try {
    const extensions = createRoundTripExtensions(codec)
    const manager = new MarkdownManager({
      marked: codec.marked,
      markedOptions: { gfm: true },
      extensions
    })
    const document = manager.parse(encoded)
    getSchema(extensions).nodeFromJSON(document).check()
    return manager.serialize(document)
  } catch {
    return null
  }
}

export function getRichMarkdownRoundTripOutput(content: string): string | null {
  const cached = roundTripCache.get(content)
  if (cached !== undefined) {
    return cached
  }

  let output: string | null = null

  try {
    const codec = createRichMarkdownEditorCodec()
    const editor = new Editor({
      element: null,
      extensions: createRoundTripExtensions(codec),
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
