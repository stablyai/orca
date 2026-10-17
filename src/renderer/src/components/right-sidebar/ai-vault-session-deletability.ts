import { isAiVaultDeletableAgent } from '../../../../shared/ai-vault-session-deletion'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { translate } from '@/i18n/i18n'
import { agentLabel } from './ai-vault-session-filters'
import {
  canUseLocalAiVaultSessionPathActions,
  isSyntheticAiVaultSessionPath
} from './ai-vault-session-path-actions'

/**
 * Why Delete is unavailable for this session, as the tooltip text to show — or
 * null when it is offered. Each message says which sessions are affected, never
 * why: a provider's storage layout is Orca's problem, not the reader's.
 *
 * A remote session's message names its host by `hostLabel`, the name the user
 * knows (the caller resolves it; the raw target id is a generated string). Only
 * a session Orca could delete locally gets the "delete it there" instruction
 * (#23556): for a synthetic row the copied path is a shared database, and an
 * unsupported agent's files are not Orca's to describe.
 *
 * NOT the security boundary — main re-validates the path on disk regardless.
 * The two sides agree on deletable-or-not but deliberately not on the order they
 * check, so an SSH session's message always names its host as well as any
 * synthetic-path or unsupported-agent reason.
 * What must hold is that renderer-deletable is a subset of main-deletable, and
 * it does: both consult the same shared agent set and host/synthetic predicates.
 */
export function aiVaultSessionDeleteBlockedReason(
  session: Pick<AiVaultSession, 'agent' | 'executionHostId' | 'filePath'>,
  hostLabel: string
): string | null {
  const remote = !canUseLocalAiVaultSessionPathActions(session.executionHostId)
  if (isSyntheticAiVaultSessionPath(session.filePath)) {
    return remote
      ? translate(
          'auto.components.right.sidebar.AiVaultSessionRow.deleteReasonRemoteHostSyntheticPath',
          "This session is on {{value0}}, and it can't be deleted from Orca.",
          { value0: hostLabel }
        )
      : translate(
          'auto.components.right.sidebar.AiVaultSessionRow.deleteReasonSyntheticPath',
          "This session can't be deleted from Orca."
        )
  }
  if (!isAiVaultDeletableAgent(session.agent)) {
    return remote
      ? translate(
          'auto.components.right.sidebar.AiVaultSessionRow.deleteReasonRemoteHostUnsupportedAgent',
          "This session is on {{value0}}, and {{value1}} sessions can't be deleted from Orca.",
          { value0: hostLabel, value1: agentLabel(session.agent) }
        )
      : translate(
          'auto.components.right.sidebar.AiVaultSessionRow.deleteReasonUnsupportedAgent',
          "{{value0}} sessions can't be deleted from Orca.",
          { value0: agentLabel(session.agent) }
        )
  }
  if (remote) {
    return translate(
      'auto.components.right.sidebar.AiVaultSessionRow.deleteReasonRemoteHost',
      "This session is on {{value0}}. Orca can only delete sessions on this device, so copy its log path and delete the session's files on {{value0}}.",
      { value0: hostLabel }
    )
  }
  return null
}
