import type { IDisposable } from '@xterm/xterm'
import { TERMINAL_KITTY_SHIFT_ENTER_INPUT } from '../../../../../../shared/terminal/protocol/input-modes/terminal-modified-enter-encoding'
import {
  sendCapturedTerminalInput,
  requestCapturedTerminalReconfirmation,
  type TerminalCapturedInputBinding
} from '../paste/terminal-captured-input-dispatch'
import { recordTerminalUserInputForLeaf } from '../terminal-input-activity'
import type { KeyboardHandlersDeps } from './terminal-keyboard-dependencies'

type CapturedPane = { id: number; leafId: string }
type CapturedKeyboardInputOptions = Pick<
  KeyboardHandlersDeps,
  'tabId' | 'managerRef' | 'paneTransportsRef' | 'panePtyBindingsRef'
> & { isLocalCmdPrompt: (pane: CapturedPane) => boolean }

export function createTerminalKeyboardInputSender({
  tabId,
  managerRef,
  paneTransportsRef,
  panePtyBindingsRef,
  isLocalCmdPrompt
}: CapturedKeyboardInputOptions) {
  return (pane: CapturedPane, data: string) => {
    const { id, leafId } = pane
    const capturedTransport = paneTransportsRef.current.get(id)
    const capturedPtyId = capturedTransport?.getPtyId() ?? null
    const capturedBinding: (IDisposable & TerminalCapturedInputBinding) | undefined =
      panePtyBindingsRef.current.get(id)
    return (overrideData = data) => {
      const currentManager = managerRef.current
      const sent = sendCapturedTerminalInput({
        targetPaneMounted:
          currentManager
            ?.getPanes()
            .some((candidate) => candidate.id === id && candidate.leafId === leafId) === true,
        currentTransport: paneTransportsRef.current.get(id),
        capturedTransport,
        capturedPtyId,
        // IME may hold cmd-only BS after its consumer changes; recheck this captured leaf, never the active pane.
        data:
          data === '\b' && overrideData === '\b' && !isLocalCmdPrompt({ id, leafId })
            ? '\x17'
            : overrideData,
        onAccepted: () => {
          if (panePtyBindingsRef.current.get(id) === capturedBinding) {
            capturedBinding?.markShortcutTerminalInputSent?.()
          }
        }
      })
      if (sent) {
        recordTerminalUserInputForLeaf(tabId, leafId)
        if (overrideData === TERMINAL_KITTY_SHIFT_ENTER_INPUT) {
          requestCapturedTerminalReconfirmation(panePtyBindingsRef.current.get(id), capturedBinding)
        }
      }
    }
  }
}
