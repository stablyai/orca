import { useRef, type RefObject } from 'react'
import { useAppStore } from '../../../store/index'
import type { NativeChatComposerHandle } from '../composer/native-chat-composer-types'
import {
  formatNativeChatQuote,
  readNativeChatQuotableSelection
} from '../../../../../shared/native-chat/input/quotes/native-chat-quote-selection'
import { readNativeChatTranscriptSelection } from './native-chat-transcript-selection'
import { SelectionAddToChatPopover } from './SelectionAddToChatPopover'
import { quoteSourceOf } from './native-chat-quote-highlight'
import { rememberNativeChatQuoteSource, type QuoteSource } from './native-chat-quote-sources'

function copyTranscriptSelectionOnSelect(root: HTMLElement): void {
  if (!useAppStore.getState().settings?.terminalClipboardOnSelect) {
    return
  }
  const text = readNativeChatTranscriptSelection(root)
  if (text) {
    // Swallowed like the terminal's copy on select: a failed copy leaves the selection to retry.
    void window.api.ui.writeClipboardText(text).catch(() => {})
  }
}

/** Adds a transcript quote to the composer, and remembers its message for the sent quote's jump. */
export function addTranscriptQuote(
  composer: NativeChatComposerHandle | null,
  text: string,
  source: QuoteSource | null
): void {
  if (source) {
    rememberNativeChatQuoteSource(text, source)
  }
  composer?.appendText(formatNativeChatQuote(text))
}

export function NativeChatSelectionQuote({
  rootRef,
  composerRef,
  enabled
}: {
  rootRef: RefObject<HTMLElement | null>
  composerRef: RefObject<NativeChatComposerHandle | null>
  enabled: boolean
}): React.JSX.Element {
  const offeredSource = useRef<QuoteSource | null>(null)
  return (
    <SelectionAddToChatPopover
      rootRef={rootRef}
      enabled={enabled}
      readQuotable={(root) => {
        const quotable = composerRef.current?.acceptsText()
          ? readNativeChatQuotableSelection(root)
          : null
        offeredSource.current = quotable
          ? quoteSourceOf(quotable.sourceElement, quotable.range)
          : null
        return quotable
      }}
      onSelectionSettled={copyTranscriptSelectionOnSelect}
      onAdd={(text) => addTranscriptQuote(composerRef.current, text, offeredSource.current)}
    />
  )
}
