import { isTerminalInputTooLargeWithDeferredMeasurement } from '../../../../../shared/terminal/input/terminal-input'
import { recordRuntimeTerminalInputForPtyId } from './runtime-terminal-input-recording'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { getRemoteRuntimePtyOwner } from '../identity/remote-runtime-pty-owner'
import type { TerminalInputKind } from '../../../../../shared/terminal/input/terminal-input-kind'
import type { RuntimeTerminalSend } from '../../../../../shared/runtime-terminal-send-contract'

const DESKTOP_RUNTIME_CLIENT = { id: 'orca-desktop', type: 'desktop' } as const

export function sendRuntimePtyInput(
  ptyId: string,
  data: string,
  inputKind: TerminalInputKind
): boolean {
  const tooLarge = isTerminalInputTooLargeWithDeferredMeasurement(data)
  if (tooLarge === true) {
    return false
  }
  if (tooLarge !== false) {
    // Yield before validating/dispatching fire-and-forget paste-sized input to avoid blocking renderer.
    void tooLarge
      .then((resolvedTooLarge) => {
        if (!resolvedTooLarge) {
          sendRuntimePtyInputWithinLimit(ptyId, data, inputKind)
        }
      })
      .catch(() => {})
    return true
  }
  return sendRuntimePtyInputWithinLimit(ptyId, data, inputKind)
}

// Only local writes accept launch kind; terminal.send’s query-reply kind is mobile-only, so host classifies desktop remote writes by bytes.
function sendRuntimePtyInputWithinLimit(
  ptyId: string,
  data: string,
  inputKind: TerminalInputKind
): boolean {
  const owner = getRemoteRuntimePtyOwner(ptyId)
  if (!owner) {
    window.api.pty.write(ptyId, data, inputKind)
    recordRuntimeTerminalInputForPtyId(ptyId)
    return true
  }

  void callRuntimeRpc<{ send: RuntimeTerminalSend }>(
    owner.target,
    'terminal.send',
    { terminal: owner.terminal, text: data, client: DESKTOP_RUNTIME_CLIENT },
    { timeoutMs: 15_000 }
  )
    .then((result) => {
      if (result.send.accepted === true) {
        recordRuntimeTerminalInputForPtyId(ptyId)
      }
    })
    .catch(() => {
      // Mirror can retire handles while xterm flushes final input; next host snapshot reattaches.
    })
  return true
}
