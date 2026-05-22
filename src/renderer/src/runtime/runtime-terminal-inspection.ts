import type { GlobalSettings } from '../../../shared/types'
import { RuntimeRpcCallError, callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'
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

function isTerminalGoneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const code =
    error instanceof RuntimeRpcCallError
      ? error.code
      : error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : ''
  return (
    code === 'terminal_handle_stale' ||
    code === 'terminal_exited' ||
    code === 'terminal_gone' ||
    message.includes('terminal_handle_stale') ||
    message.includes('terminal_exited') ||
    message.includes('terminal_gone') ||
    message.includes('no_connected_pty')
  )
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

  try {
    const result = await callRuntimeRpc<{ process: RuntimeTerminalProcessInspection }>(
      target,
      'terminal.inspectProcess',
      { terminal },
      { timeoutMs: 15_000 }
    )
    return result.process
  } catch (error) {
    if (isTerminalGoneError(error)) {
      return { foregroundProcess: null, hasChildProcesses: false }
    }
    throw error
  }
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

  void callRuntimeRpc(
    target,
    'terminal.send',
    { terminal, text: data },
    { timeoutMs: 15_000 }
  ).catch(() => {
    // Why: web session snapshots can retire a remote handle while xterm still
    // flushes a final input event. The next host snapshot will reattach.
  })
  return true
}

export async function sendRuntimePtyInputVerified(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyId: string,
  data: string
): Promise<boolean> {
  const ownerEnvironmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
  const target = ownerEnvironmentId
    ? ({ kind: 'environment', environmentId: ownerEnvironmentId } as const)
    : getActiveRuntimeTarget(settings)
  const terminal = getRemoteRuntimeTerminalHandle(ptyId)
  if (target.kind !== 'environment' || !terminal) {
    window.api.pty.write(ptyId, data)
    return true
  }

  try {
    await callRuntimeRpc(target, 'terminal.send', { terminal, text: data }, { timeoutMs: 15_000 })
    return true
  } catch (error) {
    if (isTerminalGoneError(error)) {
      return false
    }
    throw error
  }
}
