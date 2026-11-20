import { useEffect } from 'react'
import { registerDictationTerminalTarget } from '@/components/dictation/dictation-insertion-target'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from '../../pty-transport/pty-transport-types'
import { handleTerminalProgrammaticTextPaste } from './terminal-programmatic-text-paste'
import { AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS } from '../../../../../../shared/agent-launch/startup/agent-prompt-injection'

export function useTerminalDictationInsertEvent({
  isActiveRef,
  managerRef,
  paneTransportsRef,
  tabId
}: {
  isActiveRef: React.RefObject<boolean>
  managerRef: React.RefObject<PaneManager | null>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  tabId: string
}): void {
  // Dictation finishes into the pane it started in, even if this tab was switched away meanwhile.
  useEffect(
    () =>
      registerDictationTerminalTarget(tabId, {
        insert: (text, paneId) =>
          handleTerminalProgrammaticTextPaste({
            detail: { tabId, text, paneId },
            tabId,
            getManager: () => managerRef.current,
            getPaneTransports: () => paneTransportsRef.current,
            // A hidden tab's terminal must not take focus from where the user went.
            focusAfterPaste: () => isActiveRef.current
          }),
        pressEnter: async (paneId, stillQueued) => {
          // Like an agent prompt paste: the TUI must see the bracketed paste end before Enter.
          await new Promise((resolve) =>
            window.setTimeout(resolve, AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS)
          )
          if (!stillQueued()) {
            return
          }
          managerRef.current
            ?.getPanes()
            .find((pane) => pane.id === paneId)
            ?.terminal.input('\r')
        }
      }),
    [isActiveRef, managerRef, paneTransportsRef, tabId]
  )
}
