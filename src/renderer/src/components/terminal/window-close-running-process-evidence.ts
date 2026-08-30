import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { readPtyProcessInspectionEvidence } from '../../../../shared/pty-process-inspection-evidence'
import { withTimeout } from '../../../../shared/promise-timeout-fallback'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'

/**
 * Whether any local PTY must stop the window from closing silently.
 *
 * `exited` is the only verdict that closes with no prompt. A probe that could
 * not answer is `unverifiable` (docs/reference/ssh-execution-boundary.md) and
 * must never read as an idle shell: the degraded local read publishes the
 * legacy collapse — the stable-cache shell name and `hasChildProcesses: false` —
 * which is byte-identical to a genuinely idle pane unless the evidence is read.
 * Unlike every other consumer of this evidence, closing here acts for the user
 * and destroys the work the warning would have let them save, so unknown asks.
 *
 * `timeoutMs` bounds the whole probe. A local inspect is an IPC round trip into a
 * process-table scan and can stall indefinitely, and this path has no backstop:
 * main only arms its ack timer when `isQuitting`, which is exactly the branch that
 * never probes. An unbounded wait leaves the window neither closed nor prompting —
 * the silent-death shape this guard exists to remove. Unanswered blocks, matching
 * the tab and pane close paths (#10142).
 */
export async function anyLocalPtyBlocksWindowClose(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyIds: readonly string[],
  timeoutMs: number
): Promise<boolean> {
  return withTimeout(inspectAllLocalPtys(settings, ptyIds), timeoutMs, true)
}

async function inspectAllLocalPtys(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyIds: readonly string[]
): Promise<boolean> {
  const results = await Promise.allSettled(
    ptyIds.map((ptyId) => inspectRuntimeTerminalProcess(settings, ptyId))
  )
  return results.some((result) => {
    // Why rejected counts as blocking: a raised inspection answered nothing, and
    // the Promise.all this replaced had no catch — a rejection left the window
    // neither closed nor prompting.
    if (result.status === 'rejected') {
      return true
    }
    // Why before the evidence read: `unavailable` is the host saying it could not
    // route to this pane at all, and it rides with the legacy idle collapse
    // (null/false) and no evidence — so reading it would fabricate `exited` out
    // of fields nothing observed. `probeTerminalLiveness` fences the same shape
    // on the cleanup path; this one is strictly more destructive.
    //
    // Against every producer that exists today this fence is REDUNDANT, not
    // independent coverage: all five `unavailable: true` sites publish no
    // `processEvidence`, so the reader below already answers `unverifiable` (or
    // `live`) for the same result and blocks anyway. It is kept because both
    // routes into `result.value` are unvalidated casts of an independently
    // versioned peer's JSON — the daemon's `client.request<>` and the runtime's
    // `callRuntimeRpc<>` — and a peer that starts publishing `unavailable`
    // beside real evidence would otherwise ride an `exited` verdict straight
    // into a silent close (docs/reference/remote-wire-compatibility.md).
    if (result.value.unavailable === true) {
      return true
    }
    return readPtyProcessInspectionEvidence(result.value).children.verdict !== 'exited'
  })
}
