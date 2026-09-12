import type { AiVaultSearchHit } from './ai-vault-search-types'

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
