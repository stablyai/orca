import type { RuntimeRpcResponse } from '../../../../../shared/runtime-rpc-envelope'
import type { RuntimeTerminalClose } from '../../../../../shared/runtime-terminal-contracts'
import { unwrapRuntimeRpcResult } from '../../rpc/calls/runtime-rpc-result'
import { parseRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { isWebRuntimeSessionActive } from '../../web-runtime-session-environment'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { redrawServerLayoutWorkspace } from '../../server-layout-apply-routes'

/** `worktreeId`: the pane's workspace, whose server frames redraw a pane the server kept. */
export function closeWebRuntimeTerminal(
  ptyId: string | null | undefined,
  worktreeId?: string
): boolean {
  if (!ptyId) {
    return false
  }
  const remote = parseRemoteRuntimePtyId(ptyId)
  const environmentId = remote?.environmentId?.trim()
  if (!remote || !environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }

  // Close host terminal first or later authoritative snapshots resurrect the pane.
  void window.api.runtimeEnvironments
    .call({
      selector: environmentId,
      method: 'terminal.close',
      params: {
        terminal: remote.handle
      },
      timeoutMs: 15_000
    })
    .then((response) => {
      unwrapRuntimeRpcResult(response as RuntimeRpcResponse<{ close: RuntimeTerminalClose }>)
    })
    .catch((error) => {
      // Switch point: the window already dropped the pane; the server's frames draw what it kept.
      if (ORCA_LAYOUT_OWNER_IS_MAIN && worktreeId) {
        redrawServerLayoutWorkspace(environmentId, worktreeId)
      }
      console.warn(
        '[web-runtime-session] failed to close terminal pane:',
        error instanceof Error ? error.message : String(error)
      )
    })
  return true
}
