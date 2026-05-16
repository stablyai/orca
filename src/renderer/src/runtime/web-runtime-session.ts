import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeTerminalCreate, RuntimeTerminalSplit } from '../../../shared/runtime-types'
import { useAppStore } from '../store'
import { unwrapRuntimeRpcResult } from './runtime-rpc-client'
import { parseRemoteRuntimePtyId } from './runtime-terminal-stream'

export function isWebRuntimeSessionActive(
  activeRuntimeEnvironmentId: string | null | undefined
): boolean {
  return (
    Boolean((globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__) &&
    Boolean(activeRuntimeEnvironmentId?.trim())
  )
}

export async function createWebRuntimeSessionTerminal(args: {
  worktreeId: string
  environmentId?: string | null
  afterTabId?: string
  activate?: boolean
}): Promise<boolean> {
  const environmentId =
    args.environmentId?.trim() ??
    useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() ??
    null
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }

  try {
    const response = await window.api.runtimeEnvironments.call({
      selector: environmentId,
      method: 'terminal.create',
      params: {
        worktree: `id:${args.worktreeId}`,
        activate: args.activate !== false
      },
      timeoutMs: 15_000
    })
    unwrapRuntimeRpcResult(response as RuntimeRpcResponse<{ terminal: RuntimeTerminalCreate }>)
    return true
  } catch (error) {
    console.warn(
      '[web-runtime-session] failed to create terminal:',
      error instanceof Error ? error.message : String(error)
    )
    return false
  }
}

export function splitWebRuntimeTerminal(
  ptyId: string | null | undefined,
  direction: 'horizontal' | 'vertical'
): boolean {
  if (!ptyId) {
    return false
  }
  const remote = parseRemoteRuntimePtyId(ptyId)
  const environmentId = remote?.environmentId?.trim()
  if (!remote || !environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }

  // Why: split requests from the paired web client must run on the host pane.
  // A local split would mint a web-only pane and the host would mirror it back
  // as a separate tab instead of preserving the terminal split layout.
  void window.api.runtimeEnvironments
    .call({
      selector: environmentId,
      method: 'terminal.split',
      params: {
        terminal: remote.handle,
        direction
      },
      timeoutMs: 15_000
    })
    .then((response) => {
      unwrapRuntimeRpcResult(response as RuntimeRpcResponse<RuntimeTerminalSplit>)
    })
    .catch((error) => {
      console.warn(
        '[web-runtime-session] failed to split terminal:',
        error instanceof Error ? error.message : String(error)
      )
    })
  return true
}
