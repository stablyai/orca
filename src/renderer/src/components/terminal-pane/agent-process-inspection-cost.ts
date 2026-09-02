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

/**
 * Whether a pane with no agent evidence should keep a perpetual idle inspection
 * timer, or rely on pane activity (output/replay/title/hook) to arm a bounded
 * inspection schedule (2/4/6/8s, then 10/25/40s — see
 * NO_EVIDENCE_ACTIVITY_ARMED_WINDOW_MS) and go quiet after it.
 *
 * Why remote is activity-driven: a perpetual timer can only discover an agent
 * that started without printing a byte, changing the title, or firing a hook —
 * and every one of those signals already arms the schedule. On a remote pane
 * that timer costs a host round trip plus two host forks per tick, forever, so
 * it is disarmed. Local hosts keep the timer: local inspection is cheap enough
 * that the floor is worth its price.
 */
export function shouldPollNoEvidenceProcessCadenceForPty(ptyId: string | null): boolean {
  return ptyId === null || !isRemoteExecutionHostPtyId(ptyId)
}
