import type { AiVaultSearchHit, AiVaultSearchStatus } from './ai-vault-search-types'

export type SessionSearchTransport = 'ipc' | 'runtime' | 'relay'

/**
 * Undefined is a same-machine caller. Paired desktops hold workspace grants and already read
 * these fields from the session list; phones stay redacted.
 */
export function sessionSearchTransportForClient(
  clientKind: 'mobile' | 'runtime' | undefined
): SessionSearchTransport {
  return clientKind === 'mobile' ? 'relay' : 'runtime'
}

export function redactForTransport(
  hit: AiVaultSearchHit,
  transport: SessionSearchTransport
): AiVaultSearchHit {
  const { resumeCommand, source, accountHome, accountWslDistro, ...fields } = hit
  return {
    ...fields,
    ...(transport !== 'relay' && accountHome !== undefined
      ? { accountHome, accountWslDistro }
      : {}),
    source: transport === 'relay' ? { presence: source.presence } : { ...source },
    ...(transport !== 'relay' && source.presence === 'present' && resumeCommand !== undefined
      ? { resumeCommand }
      : {})
  }
}

// Native error messages can repeat private paths even after root is removed.
export function redactStatusForTransport(
  status: AiVaultSearchStatus,
  transport: SessionSearchTransport
): AiVaultSearchStatus {
  if (transport !== 'relay') {
    return status
  }
  return {
    ...status,
    degradedRoots: status.degradedRoots.map(() => ({
      reason: 'Source root could not be verified.'
    }))
  }
}
