import { translate } from '@/i18n/i18n'
import { searchKeywords } from './settings-search-keywords'

const AGENT_STATUS_HOOKS_TITLE_KEY = 'auto.components.settings.agent-status-hooks-copy.7707c15abb'
const AGENT_STATUS_HOOKS_DESCRIPTION_KEY =
  'auto.components.settings.agent-status-hooks-copy.a68a642835'

export function getAgentStatusHooksTitle(): string {
  return translate(AGENT_STATUS_HOOKS_TITLE_KEY, 'Agent status hooks')
}

export function getAgentStatusHooksDescription(): string {
  return translate(
    AGENT_STATUS_HOOKS_DESCRIPTION_KEY,
    'Shows working, waiting, and done states in Orca. Turn off to remove Orca-managed hooks and stop reinstalling them.'
  )
}

export function getAgentStatusHooksSearchKeywords(): string[] {
  return searchKeywords([
    { key: 'auto.components.settings.agents.search.0d752916f8', fallback: 'hooks' },
    { key: 'auto.components.settings.agents.search.6984d4291a', fallback: 'status' },
    { key: 'auto.components.settings.agents.search.affbf130f6', fallback: 'working' },
    { key: 'auto.components.settings.agents.search.13b20636a6', fallback: 'waiting' },
    { key: 'auto.components.settings.agents.search.8599603496', fallback: 'done' },
    { key: 'auto.components.settings.agents.search.ea71995548', fallback: 'remove' },
    { key: 'auto.components.settings.agents.search.c1317fe641', fallback: 'restore' },
    { key: 'auto.components.settings.agents.search.5963143e00', fallback: 'settings' },
    { key: 'auto.components.settings.agents.search.042c551bc5', fallback: 'config' },
    {
      key: 'auto.components.settings.agents.search.f412abbba5',
      fallback: 'claude',
      englishOnly: true
    },
    {
      key: 'auto.components.settings.agents.search.5ded38b843',
      fallback: 'codex',
      englishOnly: true
    }
  ])
}
