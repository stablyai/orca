import type { IDisposable } from '@xterm/xterm'
import { subscribeToTerminalInputData } from '../terminal-user-input-signal'
import { isPaneReplaying } from '../replay-guard'
import { isTerminalInputUnsafeDuringReplay } from '../terminal-pointer-input-sequences'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function subscribePtyInputForward(session: ConnectPanePtySession): IDisposable {
  // Emission provenance survives deferral without allocating a closure per keystroke.
  const forwardUserInput = (data: string): void => session.forwardPtyInput(data, true, false)
  const forwardReply = (data: string): void => session.forwardPtyInput(data, false, false)
  const forwardBlockedUserInput = (data: string): void => session.forwardPtyInput(data, true, true)
  const forwardBlockedReply = (data: string): void => session.forwardPtyInput(data, false, true)
  return subscribeToTerminalInputData(session.pane.terminal, (data, userInput) => {
    // Deferral can outlive both the replay guard and its temporary alternate buffer.
    const blockedAtEmission =
      isPaneReplaying(session.deps.replayingPanesRef, session.pane.id) &&
      isTerminalInputUnsafeDuringReplay(data, userInput, session.pane.terminal.buffer.active.type)
    const forward = userInput
      ? blockedAtEmission
        ? forwardBlockedUserInput
        : forwardUserInput
      : blockedAtEmission
        ? forwardBlockedReply
        : forwardReply
    if (session.deps.deferPtyInput) {
      session.deps.deferPtyInput(session.pane.id, data, forward)
      return
    }
    forward(data)
  })
}
