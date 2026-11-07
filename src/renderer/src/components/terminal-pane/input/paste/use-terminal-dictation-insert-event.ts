import { useEffect } from 'react'
import { registerDictationTerminalTarget } from '@/components/dictation/dictation-insertion-target'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from '../../pty-transport/pty-transport-types'
import { handleTerminalProgrammaticTextPaste } from './terminal-programmatic-text-paste'

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
      registerDictationTerminalTarget(tabId, (text, paneId) =>
        handleTerminalProgrammaticTextPaste({
          detail: { tabId, text, paneId },
          tabId,
          getManager: () => managerRef.current,
          getPaneTransports: () => paneTransportsRef.current,
          // A hidden tab's terminal must not take focus from where the user went.
          focusAfterPaste: () => isActiveRef.current
        })
      ),
    [isActiveRef, managerRef, paneTransportsRef, tabId]
  )
}
