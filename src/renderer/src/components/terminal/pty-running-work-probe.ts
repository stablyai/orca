import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import { isRemoteExecutionHostPtyId } from '../../../../shared/remote-execution-host-pty-id'
import { isClientOnlyUnverifiableInspection } from '../../../../shared/terminal-process-inspection'

/**
 * One probe answer in the fixed `live` / `unverifiable` / `exited` vocabulary of
 * `docs/reference/ssh-execution-boundary.md`. `exited` is only ever produced by a host that
 * answered; every failure to reach the owner — a rejection, a closed transport, or a deadline
 * that expired first — stays `unverifiable`, because loss of contact is not evidence of death.
 */
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

type ProbeSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined

/**
 * Probes every pty for running work and resolves at whichever comes first: every answer, or the
 * deadline. Never rejects, and never reports a pty it did not hear back about as idle.
 *
 * Callers own the policy. This owns only the measurement, so the tab-close guard and the
 * window-close guard cannot drift apart on what an unanswered remote host means.
 */
export async function probePtyRunningWork(
  settings: ProbeSettings,
  ptyIds: readonly string[],
  options: { timeoutMs: number }
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
        // Why the flag: this probe backs decisions that act once and destructively, so it is worth
        // a host process-table read on platforms where the child question costs one. The polled
        // inspections deliberately do not ask for it.
        const inspection = await inspectRuntimeTerminalProcess(settings, ptyId, {
          scanChildProcesses: true
        })
        probe.timedOut = false
        if (isClientOnlyUnverifiableInspection(inspection)) {
          probe.verdict = 'unverifiable'
          probe.reason = inspection.reason
          return
        }
        // `hasChildProcesses` cannot hold the third answer: a host that could not read its own
        // process table spells that the same way as one that read it and found nothing. Windows
        // relays spelled it `false` unconditionally, which read here as `exited`.
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
        // Why: `inspectRuntimeTerminalProcess` already maps every failure it can classify onto a
        // reason; an unclassified throw is still a failure to observe, so it stays unverifiable.
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
