/**
 * Evidence returned by the two independent PTY liveness probes.
 *
 * `unverifiable` means the execution host could not answer; it is never an
 * alias for process death. The optional wire field preserves this distinction
 * while old clients continue to read the legacy scalar fields.
 */
export type PtyForegroundProcessEvidence =
  | { verdict: 'live'; processName: string }
  | { verdict: 'exited'; processName: string | null }
  | { verdict: 'unverifiable'; reason: string }

export type PtyChildProcessesEvidence =
  | { verdict: 'live' }
  | { verdict: 'exited' }
  | { verdict: 'unverifiable'; reason: string }

export type PtyProcessInspectionEvidence = {
  foreground: PtyForegroundProcessEvidence
  children: PtyChildProcessesEvidence
}

export type PtyProcessVerdict = 'live' | 'unverifiable' | 'exited'

/** Any unknown component poisons the whole answer; a partial answer is not an answer. */
export function combinePtyProcessInspectionVerdict(
  evidence: PtyProcessInspectionEvidence
): PtyProcessVerdict {
  if (
    evidence.foreground.verdict === 'unverifiable' ||
    evidence.children.verdict === 'unverifiable'
  ) {
    return 'unverifiable'
  }
  // A live sample wins conservatively: prompting is safer than closing if it ended between probes.
  if (evidence.foreground.verdict === 'live' || evidence.children.verdict === 'live') {
    return 'live'
  }
  return 'exited'
}

export type PtyProcessInspectionWireResult = {
  foregroundProcess: string | null
  hasChildProcesses: boolean
  processEvidence: PtyProcessInspectionEvidence
}

/** Compose legacy fields without allowing an unverifiable probe to claim idle. */
export function buildPtyProcessInspectionWireResult(
  foreground: PtyForegroundProcessEvidence,
  children: PtyChildProcessesEvidence
): PtyProcessInspectionWireResult {
  return {
    foregroundProcess:
      foreground.verdict === 'live' || foreground.verdict === 'exited'
        ? foreground.processName
        : null,
    hasChildProcesses: children.verdict === 'live',
    processEvidence: { foreground, children }
  }
}

/**
 * Normalize evidence from a mixed-version peer. Malformed or absent evidence
 * never upgrades an unknown probe to an observed exit.
 */
export function readPtyProcessInspectionEvidence(result: {
  foregroundProcess: string | null
  hasChildProcesses: boolean
  processEvidence?: PtyProcessInspectionEvidence
}): PtyProcessInspectionEvidence {
  const evidence = result.processEvidence
  if (evidence === undefined) {
    // Legacy peers omit this field; an updated client cannot call that absence idle.
    return {
      foreground: { verdict: 'unverifiable', reason: 'peer omitted process inspection evidence' },
      children: { verdict: 'unverifiable', reason: 'peer omitted process inspection evidence' }
    }
  }
  return {
    foreground: normalizeForegroundEvidence(evidence.foreground),
    children: normalizeChildrenEvidence(evidence.children)
  }
}

/** Add an explicit unknown verdict when a mixed-version peer omitted the optional field. */
export function ensurePtyProcessInspectionEvidence<
  T extends {
    foregroundProcess: string | null
    hasChildProcesses: boolean
    processEvidence?: PtyProcessInspectionEvidence
  }
>(result: T): T & { processEvidence: PtyProcessInspectionEvidence } {
  if (result.processEvidence !== undefined) {
    return result as T & { processEvidence: PtyProcessInspectionEvidence }
  }
  return { ...result, processEvidence: readPtyProcessInspectionEvidence(result) }
}

function normalizeReason(reason: unknown): string {
  return typeof reason === 'string' ? reason : 'unspecified'
}

function normalizeForegroundEvidence(
  evidence: PtyForegroundProcessEvidence | undefined
): PtyForegroundProcessEvidence {
  if (evidence?.verdict === 'live') {
    if (typeof evidence.processName === 'string' && evidence.processName.length > 0) {
      return { verdict: 'live', processName: evidence.processName }
    }
  }
  if (evidence?.verdict === 'exited') {
    const processName = evidence.processName ?? null
    if (processName === null || typeof processName === 'string') {
      return { verdict: 'exited', processName }
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
