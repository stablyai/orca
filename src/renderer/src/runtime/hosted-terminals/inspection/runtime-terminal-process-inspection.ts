import '../input/runtime-terminal-input-recording'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimePtyOwner
} from '../identity/remote-runtime-pty-owner'
import { parseAppSshPtyId } from '../../../../../shared/ssh-pty-id'
import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import {
  clientOnlyUnverifiableInspection,
  isClientOnlyUnverifiableInspection,
  type TerminalProcessInspection,
  type TerminalProcessInspection as RuntimeTerminalProcessInspection,
  classifyTerminalProcessInspectionFailure
} from '../../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'

function isRemoteInspectionPtyId(ptyId: string): boolean {
  return getRemoteRuntimePtyEnvironmentId(ptyId) !== null || parseAppSshPtyId(ptyId) !== null
}

function normalizeInspectionResult(
  result: TerminalProcessInspection,
  remote: boolean
): RuntimeTerminalProcessInspection {
  if (typeof result !== 'object' || result === null) {
    return clientOnlyUnverifiableInspection(remote ? 'old_host' : 'terminal_gone')
  }
  // A client-only result may have crossed a mixed-version preload/runtime boundary.
  if (isClientOnlyUnverifiableInspection(result)) {
    return clientOnlyUnverifiableInspection(
      typeof result.reason === 'string' ? result.reason : 'transport_loss'
    )
  }
  // Old-host compatibility process names are not observed evidence; exclude them from remote identity.
  if (remote && result.foregroundProcessEvidence === undefined) {
    return clientOnlyUnverifiableInspection('old_host')
  }
  // Normalize removed booleans from older main/preload pairs during upgrades.
  if (
    result &&
    typeof result === 'object' &&
    'unavailable' in result &&
    (result as { unavailable?: unknown }).unavailable === true
  ) {
    return clientOnlyUnverifiableInspection('terminal_gone')
  }
  return result
}

export async function inspectRuntimeTerminalProcess(
  ptyId: string,
  options?: { expectedIncarnationId?: string; scanChildProcesses?: boolean; steadyState?: boolean }
): Promise<RuntimeTerminalProcessInspection> {
  const owner = getRemoteRuntimePtyOwner(ptyId)
  const remote = isRemoteInspectionPtyId(ptyId)
  if (!owner) {
    try {
      const result = await (options
        ? window.api.pty.inspectProcess(ptyId, options)
        : window.api.pty.inspectProcess(ptyId))
      return normalizeInspectionResult(result, remote)
    } catch (error) {
      const reason = classifyTerminalProcessInspectionFailure(error)
      if (reason) {
        return clientOnlyUnverifiableInspection(reason)
      }
      throw error
    }
  }

  try {
    const result = await callRuntimeRpc<{ process: RuntimeTerminalProcessInspection }>(
      owner.target,
      'terminal.inspectProcess',
      {
        terminal: owner.terminal,
        ...(options?.expectedIncarnationId
          ? { expectedIncarnationId: options.expectedIncarnationId }
          : {}),
        // Close guards request real process scans; dropping this causes unverifiable and confirmation on every idle remote Windows close.
        ...(options?.scanChildProcesses === true ? { scanChildProcesses: true } : {})
      },
      { timeoutMs: 15_000 }
    )
    return normalizeInspectionResult(result.process, true)
  } catch (error) {
    const reason = classifyTerminalProcessInspectionFailure(error)
    if (reason) {
      return clientOnlyUnverifiableInspection(reason)
    }
    throw error
  }
}

/**
 * Forces a fresh, uncached foreground scan for a pane whose cached inspection
 * is suspect (issue #11064: the cached read can flap to the shell for a live
 * agent). Local/daemon panes only — runtime environments expose no fresh-scan
 * RPC, and an SSH provider without confirm support answers null, which callers
 * must read as "no new evidence", never as a shell confirmation.
 */
export async function confirmRuntimeTerminalForegroundProcess(
  ptyId: string
): Promise<string | null> {
  // Why any remote id: an id without an owner segment still runs off this host, never locally.
  if (isRemoteRuntimePtyId(ptyId)) {
    return null
  }
  const confirmForegroundProcess = window.api.pty.confirmForegroundProcess
  // Why the shape check: a preload older than this handler has no such method.
  if (typeof confirmForegroundProcess !== 'function') {
    return null
  }
  return confirmForegroundProcess(ptyId).catch(() => null)
}
