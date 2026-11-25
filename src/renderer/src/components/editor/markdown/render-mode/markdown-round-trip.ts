import { Editor, getSchema } from '@tiptap/core'
import { MarkdownManager } from '@tiptap/markdown'
import { hasMarkdownReferenceDefinitionLines } from '../source-scanning/markdown-reference-link-normalization'
import { encodeRawMarkdownHtmlForRichEditor } from '../../rich-markdown/raw-source/raw-markdown-html'
import { createRichMarkdownExtensions } from '../../rich-markdown/schema/rich-markdown-extensions'
import {
  createRichMarkdownEditorCodec,
  type RichMarkdownEditorCodec
} from '../../rich-markdown/document/rich-markdown-source-transport'
import { createRichMarkdownHtmlSuperscriptLinkContext } from '../../rich-markdown/citations/rich-markdown-html-superscript-link-context'

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

function createRoundTripMarkdownManager(
  codec: RichMarkdownEditorCodec,
  extensions = createRoundTripExtensions(codec)
): MarkdownManager {
  return new MarkdownManager({ marked: codec.marked, markedOptions: { gfm: true }, extensions })
}

/** Rich mode drops definitions: the encoder strips its own, and the production parser consumes the rest. */
export function hasRichMarkdownReferenceDefinition(content: string): boolean {
  if (hasMarkdownReferenceDefinitionLines(content)) {
    return true
  }
  try {
    const codec = createRichMarkdownEditorCodec()
    const { instance } = createRoundTripMarkdownManager(codec)
    // Lex the encoded source like MarkdownManager.parse: HTML placeholders and extension blocks can expose definitions.
    const encoded = encodeRawMarkdownHtmlForRichEditor(content, codec, {
      htmlSuperscriptLinks: true
    })
    return Object.keys(instance.lexer(encoded).links).length > 0
  } catch {
    // Deeply nested containers can overflow marked's recursive lexer.
    return true
  }
}

/** Validate encoded passthrough markup with the production parser, without an EditorView. */
export function getRichMarkdownPassthroughOutput(
  encoded: string,
  codec: RichMarkdownEditorCodec
): string | null {
  try {
    const extensions = createRoundTripExtensions(codec)
    const manager = createRoundTripMarkdownManager(codec, extensions)
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
