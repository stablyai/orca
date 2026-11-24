import type { JSONContent } from '@tiptap/react'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import {
  appendPromptDocumentText,
  QUOTE_LINE
} from '../composer/editor/native-chat-prompt-document-text'

/** True when a line of the run of non-blank lines at the end of `text` is a quote line. */
function endsInQuoteRun(text: string): boolean {
  for (const line of text.split('\n').toReversed()) {
    if (line.trim() === '') {
      return false
    }
    if (QUOTE_LINE.test(line)) {
      return true
    }
  }
  return false
}

/**
 * The draft with the quote in place of `from`..`to`. A quote starts a line, so it gets a line break
 * after text on its line. Markdown continues a blockquote in the lines directly above into the
 * quote, so a blank line goes between them. The text after it goes on the chip's line. Empty
 * lines stay.
 */
export function withQuoteInserted(
  draft: string,
  quote: string,
  from = draft.length,
  to = from
): { text: string; caret: number } {
  const before = draft.slice(0, from)
  const line = before === '' || before.endsWith('\n') ? before : `${before}\n`
  const start = endsInQuoteRun(line.slice(0, -1)) ? `${line}\n` : line
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
