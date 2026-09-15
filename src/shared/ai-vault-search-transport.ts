import type { AiVaultSearchHit, AiVaultSearchStatus } from './ai-vault-search-types'

export type SessionSearchTransport = 'ipc' | 'runtime' | 'relay'

export function redactForTransport(
  hit: AiVaultSearchHit,
  transport: SessionSearchTransport
): AiVaultSearchHit {
  const { resumeCommand, source, ...fields } = hit

  return {
    ...fields,
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
