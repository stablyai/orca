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

/**
 * Re-serializes markdown through a throwaway editor that REPLICATES the mounted
 * editor's post-load state: same extension set, the file's own superscript-link
 * classification context, its image resolver context, and normalizeEmptyListItems.
 * Reconciliation's safety re-parse must match the live getMarkdown() output, or
 * docs with empty list items / local images / superscript links would spuriously
 * mismatch and silently fall back to canonical. Returns null if serialization throws.
 */
export function serializeRichMarkdownForReconcile(
  content: string,
  { htmlSuperscriptLinkContext, imageResolverContext }: RichMarkdownReconcileSerializerContext
): string | null {
  try {
    const codec = createRichMarkdownEditorCodec()
    // Why: mirror the live editor's link classification (sourceOwner/paths drive
    // whether a link serializes as a superscript link) via a fresh context built
    // from the live snapshot, without subscribing to the live editor's context.
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
