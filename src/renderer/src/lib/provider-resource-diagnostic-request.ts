import {
  parseProviderResourceDiagnosticResult,
  type ProviderResourceDiagnosticQuery
} from '../../../shared/provider-resource-diagnostics'

export function beginProviderResourceDiagnostic(args: {
  consumer: 'wake' | 'ai-vault-resume'
  executionHostId: string
  agent: string
  sessionId?: string
  transcriptPath?: string
}): string | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }
  const api = window.api?.diagnostics
  if (!api?.providerResourceEnabled || !api.observeProviderResource) {
    return undefined
  }
  const requestId = crypto.randomUUID()
  const query: ProviderResourceDiagnosticQuery = {
    requestId,
    agent: args.agent,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(args.transcriptPath ? { transcriptPath: args.transcriptPath } : {})
  }
  try {
    void api
      .observeProviderResource({ executionHostId: args.executionHostId, query })
      .then((value) => {
        const result = parseProviderResourceDiagnosticResult(value, requestId)
        // Only opaque correspondence leaves the execution owner; never log the selected path or session id.
        console.info('[provider-resource-diagnostic]', {
          requestId,
          consumer: args.consumer,
          matched: typeof result?.observationId === 'string',
          observationId:
            typeof result?.observationId === 'string' &&
            /^[a-f0-9-]{36}$/.test(result.observationId)
              ? result.observationId
              : undefined,
          epoch:
            typeof result?.epoch === 'string' && /^[a-f0-9-]{36}$/.test(result.epoch)
              ? result.epoch
              : undefined,
          verdict: 'unverifiable',
          reason: result?.reason ?? 'unsupported',
          ptyVerdict: result?.facts?.pty.verdict ?? 'unverifiable',
          hookKind: result?.facts?.hookKind,
          hookSequence: result?.facts?.hookSequence,
          receivedAt: result?.facts?.receivedAt,
          sessionCorrelationId: result?.facts?.sessionCorrelationId,
          rootResolved: result?.facts?.rootResolved === true,
          objectObserved: result?.facts?.objectObserved === true,
          providerOpenHolder: 'unverifiable',
          reportedSessionMatches: result?.facts?.reportedSessionMatches === true,
          launchTokenMatches: result?.facts?.launchTokenMatches === true,
          ptyRootStartTimeMatches: result?.facts?.ptyRootStartTimeMatches ?? null,
          lifecycleBound: false
        })
      })
      .catch(() => {})
  } catch {
    /* An older/disconnected bridge must not change the resume action. */
  }
  return requestId
}

export function providerResourceDiagnosticEnv(
  requestId: string,
  env?: Record<string, string>
): Record<string, string> {
  return { ...env, ORCA_PROVIDER_RESOURCE_DIAGNOSTIC_REQUEST_ID: requestId }
}
