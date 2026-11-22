import type { JSONContent } from '@tiptap/react'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { appendPromptDocumentText } from '../composer/editor/native-chat-prompt-document-text'

/**
 * The draft with the quote in place of `from`..`to`. A quote starts a line, so it gets a line break
 * after text on its line. The text after it goes on the chip's line. Empty lines stay.
 */
export function withQuoteInserted(
  draft: string,
  quote: string,
  from = draft.length,
  to = from
): { text: string; caret: number } {
  const before = draft.slice(0, from)
  const start = before === '' || before.endsWith('\n') ? before : `${before}\n`
  return { text: `${start}${quote}${draft.slice(to)}`, caret: start.length + quote.length }
}

export function withQuoteAppended<Draft extends { text: string; document?: JSONContent }>(
  draft: Draft,
  quote: string
): Draft {
  const { text } = withQuoteInserted(draft.text, quote)
  return { ...draft, text, document: appendPromptDocumentText(draft.document, draft.text, text) }
}

/** Written like typed input, saved at once; the draft holds it while the chat is hidden. */
export function appendQuoteToChatDraft(scopeKey: string, quote: string): void {
  const next = withQuoteAppended(readNativeChatComposerDraft(scopeKey), quote)
  updateNativeChatComposerDraft(
    scopeKey,
    { text: next.text, document: next.document },
    'immediate',
    // Drafts not loaded yet: the same append over the saved draft once it loads.
    (loaded) => withQuoteAppended(loaded, quote)
  )
}
