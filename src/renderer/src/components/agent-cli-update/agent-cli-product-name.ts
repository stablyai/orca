import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { AgentCliUpdateAgent } from '../../../../shared/agent-launch/installation/agent-cli-update'

/** The product the user installed, as its own docs name it. */
export function agentCliProductName(agent: AgentCliUpdateAgent, t: Translate = translate): string {
  return agent === 'claude'
    ? t('agentCliUpdate.claudeProduct', 'Claude Code')
    : t('agentCliUpdate.codexProduct', 'Codex CLI')
}
