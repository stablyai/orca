import { sessionAliasKey } from '../../../../shared/ai-vault-session-alias'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'

export function aiVaultDisplayedSessionKey(session: AiVaultSession, searching: boolean): string {
  return searching ? session.id : (sessionAliasKey(session) ?? session.id)
}
