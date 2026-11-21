import type { RefObject } from 'react'
import { useAppStore } from '../../../store/index'
import type { NativeChatComposerHandle } from '../composer/native-chat-composer-types'
import {
  formatNativeChatQuote,
  readNativeChatQuotableSelection
} from '../../../../../shared/native-chat/input/quotes/native-chat-quote-selection'
import type { NativeChatAuxiliaryChat } from '../pane/actions/native-chat-context-menu-target'
import {
  readNativeChatTranscriptRowSelection,
  readNativeChatTranscriptSelection
} from './native-chat-transcript-selection'
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
  enabled,
  auxiliaryChat
}: {
  rootRef: RefObject<HTMLElement | null>
  composerRef: RefObject<NativeChatComposerHandle | null>
  enabled: boolean
  auxiliaryChat?: NativeChatAuxiliaryChat
}): React.JSX.Element {
  return (
    <SelectionAddToChatPopover
      rootRef={rootRef}
      enabled={enabled}
      readQuotable={(root) =>
        composerRef.current?.acceptsText() ? readNativeChatQuotableSelection(root) : null
      }
      readAuxiliary={(root) =>
        auxiliaryChat?.referenceBlockedReason === null && composerRef.current?.acceptsText()
          ? readNativeChatTranscriptRowSelection(root)
          : null
      }
      onSelectionSettled={copyTranscriptSelectionOnSelect}
      onAdd={(text) => composerRef.current?.appendText(formatNativeChatQuote(text))}
      onAuxiliary={(reference) => auxiliaryChat?.addReference(reference)}
    />
  )
}
