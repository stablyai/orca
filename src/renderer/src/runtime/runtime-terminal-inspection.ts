import type { GlobalSettings } from '../../../shared/types'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle
} from './runtime-terminal-stream'

export type RuntimeTerminalProcessInspection = {
  foregroundProcess: string | null
  hasChildProcesses: boolean
}

const REMOTE_PTY_ID_PREFIX = 'remote:'

export function isRemoteRuntimePtyId(ptyId: string): boolean {
  return ptyId.startsWith(REMOTE_PTY_ID_PREFIX)
}

export async function inspectRuntimeTerminalProcess(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyId: string
): Promise<RuntimeTerminalProcessInspection> {
  const ownerEnvironmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
  const target = ownerEnvironmentId
    ? ({ kind: 'environment', environmentId: ownerEnvironmentId } as const)
    : getActiveRuntimeTarget(settings)
  const terminal = getRemoteRuntimeTerminalHandle(ptyId)
  if (target.kind !== 'environment' || !terminal) {
    const [foregroundProcess, hasChildProcesses] = await Promise.all([
      window.api.pty.getForegroundProcess(ptyId),
      window.api.pty.hasChildProcesses(ptyId)
    ])
    return { foregroundProcess, hasChildProcesses }
  }

  const result = await callRuntimeRpc<{ process: RuntimeTerminalProcessInspection }>(
    target,
    'terminal.inspectProcess',
    { terminal },
    { timeoutMs: 15_000 }
  )
  return result.process
}

export function sendRuntimePtyInput(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyId: string,
  data: string
): boolean {
  const ownerEnvironmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
  const target = ownerEnvironmentId
    ? ({ kind: 'environment', environmentId: ownerEnvironmentId } as const)
    : getActiveRuntimeTarget(settings)
  const terminal = getRemoteRuntimeTerminalHandle(ptyId)
  if (target.kind !== 'environment' || !terminal) {
    window.api.pty.write(ptyId, data)
    return true
  }

  void callRuntimeRpc(target, 'terminal.send', { terminal, text: data }, { timeoutMs: 15_000 })
  return true
}
