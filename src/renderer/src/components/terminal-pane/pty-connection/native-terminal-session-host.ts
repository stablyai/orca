import { useAppStore } from '@/store'
import { attachNativeTerminal } from '@/lib/pane-manager/native-terminal/native-terminal-panes'
import { followNativePaneMouseFocus } from '@/lib/pane-manager/native-terminal/native-terminal-mouse-focus'
import { dispatchNativeTerminalPasteText } from '@/lib/pane-manager/native-terminal/native-terminal-paste-text'
import { bindNativeTerminalLocalPty } from './native-terminal-tty'
import { syncNativeTerminalForwardedChords } from './native-terminal-forwarded-chords-sync'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

// Lends the native terminal this session's input path, so native keystrokes take the same
// provenance, deferral and recovery route as xterm's onData.
export function attachNativeTerminalForSession(
  session: ConnectPanePtySession,
  ptyId: string
): void {
  const { pane } = session
  attachNativeTerminal(
    pane.terminal,
    ptyId,
    {
      paneId: pane.id,
      serialize: () => pane.serializeAddon.serialize(),
      isVisible: () => session.deps.isVisibleRef.current === true,
      forwardInput: (data) => {
        const forward = (input: string): void => session.forwardPtyInput(input, true)
        if (session.deps.deferPtyInput) {
          session.deps.deferPtyInput(pane.id, data, forward)
          return
        }
        forward(data)
      },
      activatePane: () => session.manager.setActivePane(pane.id, { focus: false }),
      isActivePane: () => session.manager.getActivePane()?.id === pane.id,
      followMouseFocus: (pointer) =>
        followNativePaneMouseFocus(
          session.manager,
          pane.id,
          pointer,
          useAppStore.getState().settings?.terminalFocusFollowsMouse === true
        ),
      onSurfaceBound: (surfaceId, boundPtyId) => {
        syncNativeTerminalForwardedChords()
        bindNativeTerminalLocalPty(session.transport, surfaceId, boundPtyId)
      },
      pasteText: (text) => dispatchNativeTerminalPasteText(pane.container, text)
    },
    useAppStore.getState().settings
  )
}
