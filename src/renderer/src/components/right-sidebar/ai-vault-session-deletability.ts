import { isAiVaultDeletableAgent } from '../../../../shared/ai-vault-session-deletion'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { translate } from '@/i18n/i18n'
import { agentLabel } from './ai-vault-session-filters'
import {
  canUseLocalAiVaultSessionPathActions,
  isSyntheticAiVaultSessionPath
} from './ai-vault-session-path-actions'

/** Main revalidates disk paths; this gate uses the shared predicates but prioritizes remote-session tooltip copy. */
export function aiVaultSessionDeleteBlockedReason(
  session: Pick<AiVaultSession, 'agent' | 'executionHostId' | 'filePath'>
): string | null {
  if (!canUseLocalAiVaultSessionPathActions(session.executionHostId)) {
    return translate(
      'auto.components.right.sidebar.AiVaultSessionRow.deleteReasonNonLocalHost',
      'Only sessions on this device can be deleted.'
    )
  }
  if (isSyntheticAiVaultSessionPath(session.filePath)) {
    return translate(
      'auto.components.right.sidebar.AiVaultSessionRow.deleteReasonSyntheticPath',
      "This session can't be deleted from Orca."
    )
  }
  if (!isAiVaultDeletableAgent(session.agent)) {
    return translate(
      'auto.components.right.sidebar.AiVaultSessionRow.deleteReasonUnsupportedAgent',
      "{{value0}} sessions can't be deleted from Orca.",
      { value0: agentLabel(session.agent) }
    )
  }
  return null
}
