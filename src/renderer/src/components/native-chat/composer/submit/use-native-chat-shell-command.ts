import { useCallback } from 'react'
import { nativeChatShellCommand } from '../../../../../../shared/native-chat/input/native-chat-shell-command'
import { readNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import {
  admitNativeChatPastedText,
  projectNativeChatPastedText
} from '../../paste/native-chat-composer-pasted-text-references'
import type { NativeChatStructuredComposerTransport } from './native-chat-structured-composer-transport'

export function useNativeChatShellCommand(
  structuredTransport: NativeChatStructuredComposerTransport | undefined,
  draftScopeKey: string,
  setDraft: (value: string) => void,
  setCaret: (caret: number) => void
): (draft: string) => void {
  return useCallback(
    (draft: string) => {
      const run = structuredTransport?.runShellCommand
      if (!run || !admitNativeChatPastedText(draftScopeKey, draft, structuredTransport.onError)) {
        return
      }
      const { pastedTextFiles } = readNativeChatComposerDraft(draftScopeKey)
      const command = nativeChatShellCommand(projectNativeChatPastedText(draft, pastedTextFiles))
      if (command === null) {
        return
      }
      setDraft('')
      setCaret(0)
      run(command)
    },
    [draftScopeKey, setCaret, setDraft, structuredTransport]
  )
}
