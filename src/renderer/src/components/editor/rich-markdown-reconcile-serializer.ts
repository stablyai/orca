import { Editor } from '@tiptap/core'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import {
  createRichMarkdownHtmlSuperscriptLinkContext,
  type RichMarkdownHtmlSuperscriptLinkContext
} from './rich-markdown-html-superscript-link-context'
import {
  setRichMarkdownImageResolverContext,
  type RichMarkdownImageResolverContext
} from './rich-markdown-image-context'
import { normalizeEmptyListItems } from './rich-markdown-normalize'

export type RichMarkdownReconcileSerializerContext = {
  htmlSuperscriptLinkContext: RichMarkdownHtmlSuperscriptLinkContext
  imageResolverContext: RichMarkdownImageResolverContext
}

/** Match live extensions, normalization and link/image context in the safety reparse; mismatches would unnecessarily canonicalize source. Return null on failure. */
export function serializeRichMarkdownForReconcile(
  content: string,
  { htmlSuperscriptLinkContext, imageResolverContext }: RichMarkdownReconcileSerializerContext
): string | null {
  try {
    const codec = createRichMarkdownEditorCodec()
    // Snapshot live link-classification context without subscribing the throwaway editor to it.
    const { version: _version, ...snapshot } = htmlSuperscriptLinkContext.getSnapshot()
    const context = createRichMarkdownHtmlSuperscriptLinkContext(snapshot)
    const editor = new Editor({
      element: null,
      extensions: createRichMarkdownExtensions({
        codec,
        htmlSuperscriptLinks: true,
        htmlSuperscriptLinkContext: context
      }),
      content: encodeRawMarkdownHtmlForRichEditor(content, codec, { htmlSuperscriptLinks: true }),
      contentType: 'markdown',
      onBeforeCreate: ({ editor: nextEditor }) => {
        setRichMarkdownImageResolverContext(nextEditor, imageResolverContext)
      }
    })
    try {
      normalizeEmptyListItems(editor)
      return editor.getMarkdown()
    } finally {
      editor.destroy()
    }
  } catch {
    return null
  }
}
