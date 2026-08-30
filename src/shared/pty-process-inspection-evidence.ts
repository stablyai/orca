/**
 * Evidence contract for PTY agent-process inspection.
 *
 * The completion monitor concludes "the agent finished" from two observations:
 * the foreground process is no longer a recognized agent, and the shell has no
 * child processes. Both probes run on the execution host, and on a relay host
 * "could not ask" is a normal steady state — probes time out under load, and
 * minimal hosts lack `pgrep`. Per docs/reference/ssh-execution-boundary.md the
 * vocabulary is `live` / `unverifiable` / `exited`: a probe that failed to run
 * is `unverifiable` and must never be read as exit evidence; only a probe that
 * ran and positively observed absence may say `exited`.
 *
 * Wire compatibility (docs/reference/remote-wire-compatibility.md): the
 * evidence rides in a NEW OPTIONAL FIELD (`processEvidence`) beside the legacy
 * `foregroundProcess` / `hasChildProcesses` fields, whose published values keep
 * the exact legacy collapse. An old client ignores the field and sees identical
 * content; a new client against an old host reads the legacy fields as the only
 * available answer.
 */

import { isShellProcess } from './shell-process-detection'

export type PtyForegroundProcessEvidence =
  | { verdict: 'observed'; processName: string | null }
  | { verdict: 'unverifiable'; reason: string }

export type PtyChildProcessesEvidence =
  | { verdict: 'live' }
  | { verdict: 'exited' }
  | { verdict: 'unverifiable'; reason: string }

export type PtyProcessInspectionEvidence = {
  foreground: PtyForegroundProcessEvidence
  children: PtyChildProcessesEvidence
}

export type PtyProcessInspectionWireResult = {
  foregroundProcess: string | null
  hasChildProcesses: boolean
  processEvidence: PtyProcessInspectionEvidence
}

/**
 * Collapse probe evidence into the wire result. The legacy fields reproduce the
 * pre-evidence behavior exactly (`unverifiable` collapses to `null` / `false`)
 * so clients that predate `processEvidence` observe unchanged host content.
 */
export function buildPtyProcessInspectionWireResult(
  foreground: PtyForegroundProcessEvidence,
  children: PtyChildProcessesEvidence
): PtyProcessInspectionWireResult {
  return {
    foregroundProcess: foreground.verdict === 'observed' ? foreground.processName : null,
    hasChildProcesses: children.verdict === 'live',
    processEvidence: { foreground, children }
  }
}

const LOST_ROUTE_REASON = 'no provider could route to this PTY'

/**
 * The published shape for a PTY the host has no handle for, honest about which
 * absence it is: a watched exit publishes positive `exited` evidence and no
 * `unavailable`, while a lost route publishes `unverifiable` and keeps
 * `unavailable` — which now means exactly "could not ask".
 *
 * `foregroundProcess` / `hasChildProcesses` are `null` / `false` either way, but
 * `unavailable` is itself a legacy field and a watched exit no longer carries it,
 * so an old reader does see a change. That is Rule 3 in
 * docs/reference/remote-wire-compatibility.md ("a field the host stops
 * populating"), and it needs no capability gate only because this shape never
 * crosses a versioned peer: both producers are on the Electron IPC leg, and a
 * relay host answers an absent PTY by throwing `terminal_gone` instead.
 */
export function buildAbsentPtyInspection(
  absence: 'exited' | 'unverifiable',
  reason = LOST_ROUTE_REASON
): PtyProcessInspectionWireResult & { unavailable?: true } {
  if (absence === 'exited') {
    return buildPtyProcessInspectionWireResult(
      { verdict: 'observed', processName: null },
      { verdict: 'exited' }
    )
  }
  return {
    ...buildPtyProcessInspectionWireResult(
      { verdict: 'unverifiable', reason },
      { verdict: 'unverifiable', reason }
    ),
    unavailable: true
  }
}

/**
 * Compose the inspection a host that predates `processEvidence` can answer with.
 * Pre-v27 daemons expose only `getForegroundProcess`, so the child half is
 * inferred from the foreground name. The absent evidence is not an omission the
 * caller may fill in: such a host has no channel to say whether it OBSERVED the
 * pane or fell back to the shell title, and both publish these same two values.
 */
export function composeLegacyPtyProcessInspection(foregroundProcess: string | null): {
  foregroundProcess: string | null
  hasChildProcesses: boolean
} {
  return {
    foregroundProcess,
    hasChildProcesses: foregroundProcess !== null && !isShellProcess(foregroundProcess)
  }
}

/**
 * True when the HOST itself stated the verdicts. When it is false,
 * `readPtyProcessInspectionEvidence` is re-reading the legacy pair under the old
 * meaning, which cannot separate "observed an idle shell" from "the foreground
 * read degraded to the shell title" — `composeLegacyPtyProcessInspection` emits
 * the same bytes for both. A caller that ACTS ON ABSENCE (deleting a workspace)
 * must read an unpublished reading as `unverifiable`; a caller that only acts on
 * presence may keep the legacy meaning.
 */
export function hasPublishedPtyProcessInspectionEvidence(result: {
  processEvidence?: PtyProcessInspectionEvidence
}): boolean {
  return result.processEvidence !== undefined
}

/**
 * Read the evidence off a wire result, tolerating peers this client cannot
 * vouch for. A host that predates the field gets the legacy interpretation —
 * its published values are the only answer it can give. A malformed shape from
 * a foreign host reads as `unverifiable`, never as an observation.
 */
export function readPtyProcessInspectionEvidence(result: {
  foregroundProcess: string | null
  hasChildProcesses: boolean
  processEvidence?: PtyProcessInspectionEvidence
}): PtyProcessInspectionEvidence {
  const evidence = result.processEvidence
  if (evidence === undefined) {
    return {
      foreground: { verdict: 'observed', processName: result.foregroundProcess },
      children: result.hasChildProcesses ? { verdict: 'live' } : { verdict: 'exited' }
    }
  }
  return {
    foreground: normalizeForegroundEvidence(evidence?.foreground),
    children: normalizeChildrenEvidence(evidence?.children)
  }
}

// Field types are validated, not just verdicts: a foreign host can put any
// JSON in these slots, and an out-of-type payload must degrade to
// `unverifiable` — never ride an `observed` verdict into the exit gate.
function normalizeReason(reason: unknown): string {
  return typeof reason === 'string' ? reason : 'unspecified'
}

function normalizeForegroundEvidence(
  evidence: PtyForegroundProcessEvidence | undefined
): PtyForegroundProcessEvidence {
  if (evidence?.verdict === 'observed') {
    const processName = evidence.processName ?? null
    if (processName === null || typeof processName === 'string') {
      return { verdict: 'observed', processName }
    }
  }
  if (evidence?.verdict === 'unverifiable') {
    return { verdict: 'unverifiable', reason: normalizeReason(evidence.reason) }
  }
  return { verdict: 'unverifiable', reason: 'malformed foreground inspection evidence' }
}

function normalizeChildrenEvidence(
  evidence: PtyChildProcessesEvidence | undefined
): PtyChildProcessesEvidence {
  if (evidence?.verdict === 'live' || evidence?.verdict === 'exited') {
    return { verdict: evidence.verdict }
  }
  if (evidence?.verdict === 'unverifiable') {
    return { verdict: 'unverifiable', reason: normalizeReason(evidence.reason) }
  }
  return { verdict: 'unverifiable', reason: 'malformed child-process inspection evidence' }
}
