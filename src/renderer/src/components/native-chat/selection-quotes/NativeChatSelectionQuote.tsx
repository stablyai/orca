import type { RefObject } from 'react'
import { copySelectedTextFromUserInput } from '@/lib/clipboard/copy-selected-text-from-user-input'
import { useAppStore } from '../../../store/index'
import type { NativeChatComposerHandle } from '../composer/native-chat-composer-types'
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
  // Swallowed like the terminal's copy on select: a failed copy leaves the selection to retry.
  void copySelectedTextFromUserInput({
    text: readNativeChatTranscriptSelection(root),
    writeClipboardText: window.api.ui.writeClipboardText
  }).catch(() => {})
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
