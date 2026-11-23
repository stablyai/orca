import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { AgentCliUpdateAgent } from '../../../../shared/agent-launch/installation/agent-cli-update'

/** The product the user installed, as its own docs name it; `short` fits a list row. */
export function agentCliProductName(
  agent: AgentCliUpdateAgent,
  t: Translate = translate,
  length: 'full' | 'short' = 'full'
): string {
  switch (agent) {
    case 'claude':
      return t('agentCliUpdate.claudeProduct', 'Claude Code')
    case 'codex':
      return t('agentCliUpdate.codexProduct', 'Codex CLI')
    case 'grok':
      return t('agentCliUpdate.grokProduct', 'Grok Build')
    case 'opencode':
      return t('agentCliUpdate.opencodeProduct', 'OpenCode')
    case 'opencode2':
      return t('agentCliUpdate.opencode2Product', 'OpenCode 2')
    case 'omp':
      return t('agentCliUpdate.ompProduct', 'OMP')
    case 'copilot':
      return length === 'short'
        ? t('agentCliUpdate.copilotShortProduct', 'Copilot CLI')
        : t('agentCliUpdate.copilotProduct', 'GitHub Copilot CLI')
    case 'kimi':
      return t('agentCliUpdate.kimiProduct', 'Kimi Code')
    case 'cursor':
      return t('agentCliUpdate.cursorProduct', 'Cursor CLI')
    case 'hermes':
      return t('agentCliUpdate.hermesProduct', 'Hermes Agent')
  }
}
