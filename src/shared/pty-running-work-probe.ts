import { isRemoteExecutionHostPtyId } from './remote-execution-host-pty-id'
import {
  isClientOnlyUnverifiableInspection,
  type TerminalProcessInspection
} from './terminal-process-inspection'

/** Owning-host verdicts: see docs/reference/ssh-execution-boundary.md. */
export type PtyRunningWorkVerdict = 'live' | 'unverifiable' | 'exited'

export type PtyRunningWorkProbe = {
  ptyId: string
  verdict: PtyRunningWorkVerdict
  /** Why the owner could not be observed. Only set for `unverifiable`. */
  reason?: string
  /** The deadline expired before this pty's probe answered at all. */
  timedOut: boolean
  /** The pty is owned by a remote execution host (relay runtime or app SSH). */
  remote: boolean
}

/** Never rejects; unanswered probes stay unverifiable until owning-host evidence arrives. */
export async function probePtyRunningWorkWithInspection(
  ptyIds: readonly string[],
  options: { timeoutMs: number },
  inspect: (ptyId: string) => Promise<TerminalProcessInspection>
): Promise<PtyRunningWorkProbe[]> {
  if (ptyIds.length === 0) {
    return []
  }
  const probes: PtyRunningWorkProbe[] = ptyIds.map((ptyId) => ({
    ptyId,
    verdict: 'unverifiable',
    reason: 'probe_deadline',
    timedOut: true,
    remote: isRemoteExecutionHostPtyId(ptyId)
  }))

  const settle = Promise.all(
    ptyIds.map(async (ptyId, index) => {
      const probe = probes[index]
      if (!probe) {
        return
      }
      try {
        const inspection = await inspect(ptyId)
        probe.timedOut = false
        if (isClientOnlyUnverifiableInspection(inspection)) {
          probe.verdict = 'unverifiable'
          probe.reason = inspection.reason
          return
        }
        // The old boolean cannot distinguish an unreadable host process table.
        if (inspection.childProcessEvidence === 'unverifiable') {
          probe.verdict = 'unverifiable'
          probe.reason = 'host_child_processes_unobserved'
          return
        }
        probe.verdict =
          (inspection.childProcessEvidence ??
            (inspection.hasChildProcesses ? 'children' : 'no-children')) === 'children'
            ? 'live'
            : 'exited'
        delete probe.reason
      } catch {
        // An inspection failure cannot prove that execution stopped.
        probe.timedOut = false
        probe.verdict = 'unverifiable'
        probe.reason = 'probe_failed'
      }
    })
  )

  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      settle,
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, options.timeoutMs)
      })
    ])
  } finally {
    clearTimeout(deadline)
  }
  return probes
}
