import type { RefObject } from 'react'
import { useAppStore } from '../../store'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import {
  formatNativeChatQuote,
  readNativeChatQuotableSelection,
  readNativeChatTranscriptSelection
} from './native-chat-quote-selection'
import { SelectionAddToChatPopover } from './SelectionAddToChatPopover'

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

export function NativeChatSelectionQuote({
  rootRef,
  composerRef,
  enabled
}: {
  rootRef: RefObject<HTMLElement | null>
  composerRef: RefObject<NativeChatComposerHandle | null>
  enabled: boolean
}): React.JSX.Element {
  return (
    <SelectionAddToChatPopover
      rootRef={rootRef}
      enabled={enabled}
      readQuotable={(root) =>
        composerRef.current?.acceptsText() ? readNativeChatQuotableSelection(root) : null
      }
      onSelectionSettled={copyTranscriptSelectionOnSelect}
      onAdd={(text) => composerRef.current?.appendText(formatNativeChatQuote(text))}
    />
  )
}
