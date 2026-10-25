import { unwrapRuntimeRpcResult } from './runtime-rpc-result'
import { parseRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import { isWebRuntimeSessionActive } from './web-runtime-session-environment'

// Clear host buffer or snapshot replay undoes local terminal.clear().
export function clearWebRuntimeTerminalBuffer(ptyId: string | null | undefined): boolean {
  return callWebRuntimeTerminalAction(ptyId, 'terminal.clearBuffer', 'clear terminal buffer')
}

// Reset host modes or its next snapshot rearms them.
export function resetWebRuntimeTerminalInputModes(ptyId: string | null | undefined): boolean {
  return callWebRuntimeTerminalAction(
    ptyId,
    'terminal.resetInputModes',
    'reset terminal input modes'
  )
}

function callWebRuntimeTerminalAction(
  ptyId: string | null | undefined,
  method: 'terminal.clearBuffer' | 'terminal.resetInputModes',
  action: string
): boolean {
  if (!ptyId) {
    return false
  }
  const remote = parseRemoteRuntimePtyId(ptyId)
  const environmentId = remote?.environmentId?.trim()
  if (!remote || !environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }
  void window.api.runtimeEnvironments
    .call({
      selector: environmentId,
      method,
      params: { terminal: remote.handle },
      timeoutMs: 15_000
    })
    .then((response) => {
      unwrapRuntimeRpcResult(response)
    })
    .catch((error) => {
      console.warn(
        `[web-runtime-session] failed to ${action}:`,
        error instanceof Error ? error.message : String(error)
      )
    })
  return true
}
