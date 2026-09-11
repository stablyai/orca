import type { CliInstallStatus } from '../../../../shared/cli-install-types'

// Why: Electron re-wraps a rejected `ipcMain.handle` as
// `Error invoking remote method '<channel>': Error: <message>`, so the installer's
// own sentence is buried behind transport noise by the time it reaches the panel.
const IPC_INVOKE_PREFIX = /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/

export type CliInstallFailure = {
  /** The main-process reason verbatim; installer throws already embed their own remedy. */
  reason: string
  /** Set only for a conflict, whose status detail names the path but stops short of the remedy. */
  conflictCommandPath: string | null
}

/**
 * A registration call that resolved without landing. The main process already
 * reported why in `detail`, so this only decides that it failed — it does not
 * re-classify the reason.
 */
export function readCliInstallFailure(
  status: CliInstallStatus,
  fallbackReason: string
): CliInstallFailure | null {
  if (status.state === 'installed') {
    return null
  }
  return {
    reason: status.detail?.trim() || fallbackReason,
    conflictCommandPath: status.state === 'conflict' ? status.commandPath : null
  }
}

/** A registration call that threw: unwrap the transport prefix off the installer's message. */
export function readCliInstallRejection(error: unknown, fallbackReason: string): CliInstallFailure {
  const message = error instanceof Error ? error.message : String(error)
  return {
    reason: message.replace(IPC_INVOKE_PREFIX, '').trim() || fallbackReason,
    conflictCommandPath: null
  }
}
