import { isRemoteExecutionHostPtyId } from './remote-execution-host-pty'

/**
 * Whether one cadence process inspection for this pane is expensive enough that
 * a pane with no agent evidence should relax to the `no-evidence` tier.
 *
 * Why remote first: a remote inspection is a `terminal.inspectProcess` /
 * `pty.inspectProcess` round trip to the execution host plus a host-side
 * foreground scan there — the costliest shape in this codebase, on every client
 * platform. Local Windows is costly for a different reason: it forks a
 * powershell.exe whole-process-table CIM scan per poll (~10-40x POSIX `ps`).
 * Local POSIX (and daemon/WSL panes on it) stays on the full cadence.
 *
 * Relaxing is the interim measure: once this renderer consumes the batched
 * foreground evidence direct-SSH/remote authorities already publish with their
 * PTY inventory (#17525), those panes can drop to `shouldPollNoEvidenceProcessCadence`
 * and stop scheduling idle host reads altogether.
 */
export function isAgentProcessInspectionCostly(userAgent: string, ptyId: string | null): boolean {
  if (ptyId !== null && isRemoteExecutionHostPtyId(ptyId)) {
    return true
  }
  if (!userAgent.includes('Windows')) {
    return false
  }
  return ptyId !== null
}
