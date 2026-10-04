import { unwrapRuntimeRpcResult } from './runtime-rpc-client'
import { parseRemoteRuntimePtyId } from './runtime-terminal-stream'
import { isWebRuntimeSessionActive } from './web-runtime-session-environment'

// Why: local pane.terminal.clear() is undone by the next host snapshot replay; clear the host buffer so it sticks.
export function clearWebRuntimeTerminalBuffer(ptyId: string | null | undefined): boolean {
  return callWebRuntimeTerminalAction(ptyId, 'terminal.clearBuffer', 'clear terminal buffer')
}

// Why: same as clear; the host's snapshot would re-arm the modes on the next replay.
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
