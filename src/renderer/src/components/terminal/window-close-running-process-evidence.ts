import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { readPtyProcessInspectionEvidenceForAbsenceAction } from '../../../../shared/pty-process-inspection-evidence'
import { withTimeout } from '../../../../shared/promise-timeout-fallback'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'

/**
 * Whether any PTY the window owns must stop it from closing silently.
 *
 * Every pane is probed on the host that actually runs it: `inspectProcess` is
 * dispatched by PTY id, so a direct-SSH pane's shell is inspected on the remote
 * box (ssh-pty-provider's `pty.inspectProcess` request). Panes were previously
 * filtered down to local ones, which closed the window over remote work nobody
 * had looked at.
 *
 * `exited` is the only verdict that closes with no prompt. A probe that could
 * not answer is `unverifiable` (docs/reference/ssh-execution-boundary.md) and
 * must never read as an idle shell: the degraded local read publishes the
 * legacy collapse — the stable-cache shell name and `hasChildProcesses: false` —
 * which is byte-identical to a genuinely idle pane unless the evidence is read.
 * Unlike every other consumer of this evidence, closing here acts for the user
 * and destroys the work the warning would have let them save, so unknown asks.
 *
 * `timeoutMs` bounds the whole probe. An inspect is an IPC round trip into a
 * process-table scan — over SSH, a round trip to another machine on top — and
 * can stall indefinitely, and this path has no backstop: main only arms its ack
 * timer when `isQuitting`, which is exactly the branch that never probes. An
 * unbounded wait leaves the window neither closed nor prompting — the silent-death
 * shape this guard exists to remove. Unanswered blocks, matching the tab and pane
 * close paths (#10142).
 */
export async function anyPtyBlocksWindowClose(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyIds: readonly string[],
  timeoutMs: number
): Promise<boolean> {
  return withTimeout(inspectAllPtys(settings, ptyIds), timeoutMs, true)
}

async function inspectAllPtys(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyIds: readonly string[]
): Promise<boolean> {
  const results = await Promise.allSettled(
    ptyIds.map((ptyId) => inspectRuntimeTerminalProcess(settings, ptyId))
  )
  return results.some((result) => {
    // Why rejected counts as blocking: a raised inspection answered nothing, and
    // the Promise.all this replaced had no catch — a rejection left the window
    // neither closed nor prompting. It is also the steady state of a remote host
    // this client cannot vouch for: a relay predating `pty.inspectProcess` raises
    // method-not-found, and a dropped SSH connection raises too. Neither observed
    // an absence, so neither may be spent as one.
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
    // Why the absence-action reader and no fence of its own here: a host that omits
    // the verdict has no channel to separate an observed idle shell from its legacy
    // degraded collapse, and it publishes the same two values for both — so the plain
    // reader restates that collapse as `exited`. Keying a fence on the PTY id's
    // execution host read as a proxy for "answered by an independently updated peer"
    // and got the daemon wrong; keying it on the absent field got it right but put a
    // second copy of one rule in this file. The rule now lives once, in the reader, and
    // the terminal-tab close guard reads the verdict through the same call — the shape
    // below reached that guard as `exited` and closed a tab silently for as long as the
    // two were expressed separately.
    return (
      readPtyProcessInspectionEvidenceForAbsenceAction(result.value).children.verdict !== 'exited'
    )
  })
}
