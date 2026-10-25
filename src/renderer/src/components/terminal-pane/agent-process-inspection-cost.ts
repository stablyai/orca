import { isRemoteExecutionHostPtyId } from '../../../../shared/remote-execution-host-pty-id'

/** Relax idle inspection on remote round trips and Windows process-table scans; preserve local POSIX cadence until batched host evidence can replace polling. */
export function isAgentProcessInspectionCostly(userAgent: string, ptyId: string | null): boolean {
  if (isRemoteExecutionHostPtyId(ptyId)) {
    return true
  }
  if (!userAgent.includes('Windows')) {
    return false
  }
  return ptyId !== null
}
