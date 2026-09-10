export type ProviderResourceDiagnosticHook = {
  paneKey: string
  launchToken?: string
  hookEventName?: string
  providerSession?: { id: string; transcriptPath?: string }
}

export type ProviderResourceDiagnosticOperation =
  | { kind: 'hook'; hook: ProviderResourceDiagnosticHook }
  | { kind: 'query'; query: ProviderResourceDiagnosticQuery }

/** Diagnostic correspondence only; none of these facts authorizes invocation or recovery. */
export type ProviderResourceDiagnosticQuery = {
  requestId: string
  agent: string
  transcriptPath?: string
  sessionId?: string
  epoch?: string
}

export type ProviderResourceDiagnosticResult = {
  version: 1
  requestId: string
  verdict: 'unverifiable'
  reason:
    | 'unsupported'
    | 'unreachable'
    | 'missing-retention'
    | 'stale-epoch'
    | 'path-replaced'
    | 'conflicting-candidates'
    | 'probe-capacity'
    | 'missing-lifecycle-contract'
  epoch?: string
  observationId?: string
  facts?: {
    rootResolved: boolean
    objectObserved: boolean
    objectScope: 'host-retained-read-descriptor'
    providerOpenHolder: 'unverifiable'
    reportedSessionMatches: boolean
    launchTokenMatches: boolean
    pty: { id: string; incarnationId: string; verdict: 'live' | 'unverifiable' | 'exited' }
    providerProcess: 'unverifiable'
    ptyRootStartTimeMatches: boolean | null
    lifecycleBound: false
    hookSequence: number
    hookKind: string
    receivedAt: number
    sessionCorrelationId: string
  }
}

export function unavailableProviderResourceDiagnostic(
  requestId: string,
  reason: ProviderResourceDiagnosticResult['reason']
): ProviderResourceDiagnosticResult {
  return { version: 1, requestId, verdict: 'unverifiable', reason }
}

export function isProviderResourceDiagnosticOperation(
  value: unknown
): value is ProviderResourceDiagnosticOperation {
  if (!value || typeof value !== 'object') {
    return false
  }
  const input = value as Record<string, unknown>
  const bounded = (field: unknown, max: number, optional = false): boolean =>
    (optional && field === undefined) ||
    (typeof field === 'string' && field.length > 0 && field.length <= max)
  if (input.kind === 'query' && input.query && typeof input.query === 'object') {
    const query = input.query as Record<string, unknown>
    return (
      bounded(query.requestId, 64) &&
      /^[a-zA-Z0-9-]+$/.test(query.requestId as string) &&
      bounded(query.agent, 32) &&
      bounded(query.transcriptPath, 4096, true) &&
      bounded(query.sessionId, 512, true) &&
      bounded(query.epoch, 64, true)
    )
  }
  if (input.kind === 'hook' && input.hook && typeof input.hook === 'object') {
    const hook = input.hook as Record<string, unknown>
    const session = hook.providerSession as Record<string, unknown> | undefined
    return (
      bounded(hook.paneKey, 512) &&
      bounded(hook.launchToken, 512, true) &&
      bounded(hook.hookEventName, 64, true) &&
      (session === undefined ||
        (session !== null &&
          typeof session === 'object' &&
          bounded(session.id, 512) &&
          bounded(session.transcriptPath, 4096, true)))
    )
  }
  return false
}

export function parseProviderResourceDiagnosticResult(
  value: unknown,
  requestId: string
): ProviderResourceDiagnosticResult | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const input = value as Record<string, unknown>
  const reasons = [
    'unsupported',
    'unreachable',
    'missing-retention',
    'stale-epoch',
    'path-replaced',
    'conflicting-candidates',
    'probe-capacity',
    'missing-lifecycle-contract'
  ]
  if (
    input.version !== 1 ||
    input.requestId !== requestId ||
    input.verdict !== 'unverifiable' ||
    typeof input.reason !== 'string' ||
    !reasons.includes(input.reason)
  ) {
    return null
  }
  const opaque = (field: unknown): field is string =>
    typeof field === 'string' && /^[a-f0-9-]{36}$/.test(field)
  const result: ProviderResourceDiagnosticResult = {
    version: 1,
    requestId,
    verdict: 'unverifiable',
    reason: input.reason as ProviderResourceDiagnosticResult['reason'],
    ...(opaque(input.epoch) ? { epoch: input.epoch } : {}),
    ...(opaque(input.observationId) ? { observationId: input.observationId } : {})
  }
  const facts = input.facts as Record<string, unknown> | undefined
  const pty = facts?.pty as Record<string, unknown> | undefined
  if (
    !facts ||
    !pty ||
    typeof pty.id !== 'string' ||
    pty.id.length > 512 ||
    !opaque(pty.incarnationId) ||
    !['live', 'unverifiable', 'exited'].includes(pty.verdict as string) ||
    ['rootResolved', 'objectObserved', 'reportedSessionMatches', 'launchTokenMatches'].some(
      (key) => typeof facts[key] !== 'boolean'
    ) ||
    facts.objectScope !== 'host-retained-read-descriptor' ||
    facts.providerOpenHolder !== 'unverifiable' ||
    facts.providerProcess !== 'unverifiable' ||
    facts.lifecycleBound !== false ||
    (facts.ptyRootStartTimeMatches !== null &&
      typeof facts.ptyRootStartTimeMatches !== 'boolean') ||
    !Number.isSafeInteger(facts.hookSequence) ||
    typeof facts.receivedAt !== 'number' ||
    !Number.isFinite(facts.receivedAt) ||
    !opaque(facts.sessionCorrelationId) ||
    typeof facts.hookKind !== 'string' ||
    !['SessionStart', 'SessionEnd', 'Stop', 'PreCompact', 'PostCompact'].includes(facts.hookKind)
  ) {
    return result
  }
  result.facts = {
    rootResolved: facts.rootResolved as boolean,
    objectObserved: facts.objectObserved as boolean,
    objectScope: 'host-retained-read-descriptor',
    providerOpenHolder: 'unverifiable',
    reportedSessionMatches: facts.reportedSessionMatches as boolean,
    launchTokenMatches: facts.launchTokenMatches as boolean,
    pty: {
      id: pty.id,
      incarnationId: pty.incarnationId,
      verdict: pty.verdict as 'live' | 'unverifiable' | 'exited'
    },
    providerProcess: 'unverifiable',
    lifecycleBound: false,
    ptyRootStartTimeMatches: facts.ptyRootStartTimeMatches as boolean | null,
    hookSequence: facts.hookSequence as number,
    hookKind: facts.hookKind,
    receivedAt: facts.receivedAt,
    sessionCorrelationId: facts.sessionCorrelationId
  }
  return result
}
