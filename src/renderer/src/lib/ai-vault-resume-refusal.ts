import { aiVaultAgentLabel, type AiVaultAgent } from '../../../shared/ai-vault-types'
import { translate } from '@/i18n/i18n'
import { compactIpcErrorMessage } from './ipc-error'

export function isAiVaultOwnershipRefusal(message: string): boolean {
  const code = compactIpcErrorMessage(message)
  return code === 'agent_session_conflict' || code === 'agent_session_ownership_unknown'
}

export function describeAiVaultResumeFailure(error: unknown, agent: AiVaultAgent): string {
  const message = error instanceof Error ? error.message : null
  const code = message ? compactIpcErrorMessage(message) : null
  if (code === 'agent_session_conflict') {
    return translate(
      'auto.lib.aiVaultResumeRefusal.openInChat',
      'This {{value0}} conversation is open in a chat. Refresh Session History to open it.',
      { value0: aiVaultAgentLabel(agent) }
    )
  }
  if (code === 'agent_session_ownership_unknown') {
    return translate(
      'auto.lib.aiVaultResumeRefusal.ownershipUnknown',
      'Orca could not confirm who owns this {{value0}} conversation. Refresh Session History and try again.',
      { value0: aiVaultAgentLabel(agent) }
    )
  }
  return (
    message ??
    translate(
      'auto.components.right.sidebar.AiVaultPanel.prepareSessionResumeFailed',
      'Could not prepare this session for resume.'
    )
  )
}
