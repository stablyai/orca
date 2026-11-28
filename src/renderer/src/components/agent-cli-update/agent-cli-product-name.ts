import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { AgentCliUpdateAgent } from '../../../../shared/agent-launch/installation/agent-cli-update'
import {
  AGENT_CLI_COPILOT_SHORT_PRODUCT_NAME,
  AGENT_CLI_PRODUCT_NAMES as NAMES
} from '../../../../shared/agent-launch/installation/agent-cli-product-names'

/** The product the user installed, as its own docs name it; `short` fits a list row. */
export function agentCliProductName(
  agent: AgentCliUpdateAgent,
  t: Translate = translate,
  length: 'full' | 'short' = 'full'
): string {
  switch (agent) {
    case 'claude':
      return t('agentCliUpdate.claudeProduct', NAMES.claude)
    case 'codex':
      return t('agentCliUpdate.codexProduct', NAMES.codex)
    case 'grok':
      return t('agentCliUpdate.grokProduct', NAMES.grok)
    case 'opencode':
      return t('agentCliUpdate.opencodeProduct', NAMES.opencode)
    case 'opencode2':
      return t('agentCliUpdate.opencode2Product', NAMES.opencode2)
    case 'omp':
      return t('agentCliUpdate.ompProduct', NAMES.omp)
    case 'copilot':
      return length === 'short'
        ? t('agentCliUpdate.copilotShortProduct', AGENT_CLI_COPILOT_SHORT_PRODUCT_NAME)
        : t('agentCliUpdate.copilotProduct', NAMES.copilot)
    case 'kimi':
      return t('agentCliUpdate.kimiProduct', NAMES.kimi)
    case 'cursor':
      return t('agentCliUpdate.cursorProduct', NAMES.cursor)
    case 'hermes':
      return t('agentCliUpdate.hermesProduct', NAMES.hermes)
    case 'goose':
      return t('agentCliUpdate.gooseProduct', NAMES.goose)
    case 'aug':
      return t('agentCliUpdate.auggieProduct', NAMES.aug)
    case 'kilo':
      return t('agentCliUpdate.kiloProduct', NAMES.kilo)
    case 'mimo-code':
      return t('agentCliUpdate.mimoCodeProduct', NAMES['mimo-code'])
    case 'qwen-code':
      return t('agentCliUpdate.qwenCodeProduct', NAMES['qwen-code'])
    case 'devin':
      return t('agentCliUpdate.devinProduct', NAMES.devin)
    case 'codebuddy':
      return t('agentCliUpdate.codebuddyProduct', NAMES.codebuddy)
    case 'antigravity':
      return t('agentCliUpdate.antigravityProduct', NAMES.antigravity)
  }
}
