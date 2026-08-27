import { translate } from '@/i18n/i18n'

const AGENT_STALL_RECOVERY_TITLE_KEY =
  'auto.components.settings.agent-stall-recovery-copy.50ce4fca77'
const AGENT_STALL_RECOVERY_DESCRIPTION_KEY =
  'auto.components.settings.agent-stall-recovery-copy.26c50479c3'

export function getAgentStallRecoveryTitle(): string {
  return translate(AGENT_STALL_RECOVERY_TITLE_KEY, 'Auto-continue stalled agents')
}

export function getAgentStallRecoveryDescription(): string {
  return translate(
    AGENT_STALL_RECOVERY_DESCRIPTION_KEY,
    'When an agent stops on a login or network failure, Orca re-prompts it to continue — and every other agent stalled the same way. It backs off between tries instead of restarting in a loop.'
  )
}
