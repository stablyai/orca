import { isAiVaultDeletableAgent } from '../../../../shared/ai-vault-session-deletion'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { parseRoutableExecutionHostId } from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { agentLabel } from './ai-vault-session-filters'
import {
  canUseLocalAiVaultSessionPathActions,
  isSyntheticAiVaultSessionPath
} from './ai-vault-session-path-actions'

/** How the row's owning host answers delete; null support means not yet probed, so the click checks. */
export type AiVaultSessionDeleteHost = {
  label: string
  deleteSupported: boolean | null
}

/** The runtime that owns this row, or null for this computer and unroutable hosts. */
export function aiVaultSessionRuntimeEnvironmentId(
  session: Pick<AiVaultSession, 'executionHostId'>
): string | null {
  const host = parseRoutableExecutionHostId(session.executionHostId)
  return host?.kind === 'runtime' ? host.environmentId : null
}

export function aiVaultSessionHostUpdateRequiredReason(hostLabel: string): string {
  return translate(
    'auto.components.right.sidebar.AiVaultSessionRow.deleteReasonHostUpdateRequired',
    'Update {{value0}} to delete its sessions from here.',
    { value0: hostLabel }
  )
}

/** Main and the owning host revalidate disk paths; this gate mirrors their predicates for the tooltip. */
export function aiVaultSessionDeleteBlockedReason(
  session: Pick<AiVaultSession, 'agent' | 'executionHostId' | 'filePath'>,
  host: AiVaultSessionDeleteHost
): string | null {
  const runtimeHosted = aiVaultSessionRuntimeEnvironmentId(session) !== null
  if (!runtimeHosted && !canUseLocalAiVaultSessionPathActions(session.executionHostId)) {
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
  if (runtimeHosted && host.deleteSupported === false) {
    return aiVaultSessionHostUpdateRequiredReason(host.label)
  }
  return null
}
