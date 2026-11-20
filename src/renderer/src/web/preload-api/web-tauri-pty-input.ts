import type { TerminalInputKind } from '../../../../shared/terminal/input/terminal-input-kind'
import type { RuntimeTerminalSend } from '../../../../shared/terminal/runtime/runtime-terminal-send-contract'
import { readTerminalSendAcknowledgment } from '../../../../shared/terminal/pty/lifecycle/terminal-send-acknowledgment'
import { callTauriPtyHost } from './web-tauri-pty-host'
import { notifyTauriPtyWriteUnavailable } from './web-tauri-pty-event-channel'
import type { TauriPtyState } from './web-tauri-pty-state'

export async function writeTauriPtyInputAccepted(
  state: TauriPtyState,
  data: string,
  inputKind: TerminalInputKind,
  options?: { requireWriteSettlement?: true }
): Promise<boolean> {
  if (!data) {
    return true
  }
  const queryReply = inputKind === 'query-reply'
  let accepted: boolean
  if (options?.requireWriteSettlement && queryReply) {
    // Query replies cannot be retained for replay or sent as desktop unary input.
    accepted = false
  } else if (state.stream.acknowledgesInput()) {
    const seq = state.inputSession.journal.send(state.stream, state.endpoint, [
      { text: data, queryReply }
    ])[0]
    accepted =
      queryReply || (seq !== undefined && (await state.inputSession.journal.whenAcknowledged(seq)))
  } else if (options?.requireWriteSettlement) {
    // A legacy stream confirms transport delivery only; ask the host before dismissing UI.
    const result = await callTauriPtyHost<{ send: RuntimeTerminalSend }>(
      state.id,
      'terminal.send',
      {
        terminal: state.handle,
        text: data,
        requireWriteSettlement: true,
        client: { id: `tauri-pty:${state.id}`, type: 'desktop' },
        ...(state.endpoint.incarnationId
          ? { expectedIncarnationId: state.endpoint.incarnationId }
          : {})
      }
    )
    const acknowledgment = readTerminalSendAcknowledgment(result)
    if (acknowledgment === 'unverifiable') {
      throw new Error('PTY write acknowledgment unavailable')
    }
    accepted = acknowledgment === 'accepted'
  } else {
    accepted = state.stream.sendInput(data)
  }
  if (!accepted) {
    notifyTauriPtyWriteUnavailable(state.id)
  }
  return accepted
}
