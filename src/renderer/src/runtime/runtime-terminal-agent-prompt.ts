import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { RuntimeTerminalSend } from '../../../shared/runtime-types'
import { CLIENT_SURFACE_WEB_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { isTerminalInputTooLargeWithDeferredMeasurement } from '../../../shared/terminal-input'
import { classifyTerminalProcessInspectionFailure } from '../../../shared/terminal-process-inspection'
import { isWebClientLocation } from '../lib/web-client-location'
import { useAppStore } from '../store'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'
import { recordRuntimeTerminalInputForPtyId } from './runtime-terminal-inspection'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle
} from './runtime-terminal-stream'

const DESKTOP_RUNTIME_CLIENT = { id: 'orca-desktop', type: 'desktop' } as const

/** Submit one complete Agent prompt to its owning paired Runtime. Local and
 * direct-SSH PTYs return null so callers retain their existing byte path. */
export function sendRuntimeAgentPrompt(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyId: string,
  text: string,
  signal?: AbortSignal
): Promise<boolean> | null {
  const ownerEnvironmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
  const target = ownerEnvironmentId
    ? ({ kind: 'environment', environmentId: ownerEnvironmentId } as const)
    : getActiveRuntimeTarget(settings)
  const terminal = getRemoteRuntimeTerminalHandle(ptyId)
  const supportsSemanticAgentPrompt = ownerEnvironmentId
    ? useAppStore
        .getState()
        .runtimeStatusByEnvironmentId.get(ownerEnvironmentId)
        ?.status?.capabilities?.includes(CLIENT_SURFACE_WEB_RUNTIME_CAPABILITY) === true
    : false
  if (
    !isWebClientLocation() ||
    target.kind !== 'environment' ||
    !terminal ||
    !supportsSemanticAgentPrompt
  ) {
    return null
  }
  return (async () => {
    const tooLarge = isTerminalInputTooLargeWithDeferredMeasurement(text)
    if (typeof tooLarge === 'boolean' ? tooLarge : await tooLarge) {
      return false
    }
    try {
      const result = await callRuntimeRpc<{ send: RuntimeTerminalSend }>(
        target,
        'terminal.send',
        {
          terminal,
          text,
          enter: true,
          agentPrompt: true,
          client: DESKTOP_RUNTIME_CLIENT
        },
        { timeoutMs: 15_000, signal }
      )
      if (result.send.accepted !== true) {
        return false
      }
      recordRuntimeTerminalInputForPtyId(ptyId)
      return true
    } catch (error) {
      if (classifyTerminalProcessInspectionFailure(error) === 'terminal_gone') {
        return false
      }
      throw error
    }
  })()
}
