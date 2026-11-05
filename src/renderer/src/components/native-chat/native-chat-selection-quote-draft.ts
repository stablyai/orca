import type { JSONContent } from '@tiptap/react'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { appendPromptDocumentText } from './native-chat-prompt-document-text'

/** The quote after what the draft holds, as typing it would: nothing is replaced or deduplicated. */
export function withQuoteAppended<Draft extends { text: string; document?: JSONContent }>(
  draft: Draft,
  quote: string
): Draft {
  const kept = draft.text.trimEnd()
  const text = kept === '' ? quote : `${kept}\n\n${quote}`
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
