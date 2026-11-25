import type { JSONContent } from '@tiptap/react'
import { promptTextContent } from '../../composer/editor/native-chat-prompt-document-text'

/** `document` with the lines `quoted` puts before `text` (a reply's quote) added as paragraphs. */
export function nativeChatQuotedPromptDocument(
  document: JSONContent | undefined,
  text: string,
  quoted: string
): JSONContent | undefined {
  if (!document || !text.trim()) {
    return document && promptTextContent(quoted)
  }
  // The quote ends with a blank line before the words; that blank line becomes an empty paragraph.
  const lead = promptTextContent(quoted.slice(0, quoted.length - text.length - 1)).content ?? []
  return { ...document, content: [...lead, ...(document.content ?? [])] }
}
