import type { JSONContent } from '@tiptap/react'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { appendPromptDocumentText } from '../composer/editor/native-chat-prompt-document-text'
import { appendNativeChatQuote } from '../../../../../shared/native-chat/input/quotes/native-chat-quote-selection'

export function withQuoteAppended<Draft extends { text: string; document?: JSONContent }>(
  draft: Draft,
  quote: string
): Draft {
  const text = appendNativeChatQuote(draft.text, quote)
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
