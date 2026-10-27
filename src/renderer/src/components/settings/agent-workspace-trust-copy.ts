import { translate } from '@/i18n/i18n'
import { searchKeywords } from './settings-search-keywords'

export function getAgentWorkspaceTrustTitle(): string {
  return translate(
    'auto.components.settings.agent-workspace-trust-copy.title',
    'Trust the folder when Orca starts an agent'
  )
}

export function getAgentWorkspaceTrustDescription(): string {
  return translate(
    'auto.components.settings.agent-workspace-trust-copy.description',
    'Agents Orca starts skip their "Do you trust this folder?" prompt, so the project\'s agent hooks and settings run right away. Without this, each agent asks the first time it runs in a folder. Agents running without you watching, such as orchestration workers, automations and agents started from your phone, will wait at that question until you answer it in their terminal. Folders already trusted stay trusted.'
  )
}

export function getAgentWorkspaceTrustSearchKeywords(): string[] {
  return searchKeywords([
    { key: 'auto.components.settings.agents.search.agent-trust-trust', fallback: 'trust' },
    { key: 'auto.components.settings.agents.search.agent-trust-folder', fallback: 'folder' },
    { key: 'auto.components.settings.agents.search.agent-trust-worktree', fallback: 'worktree' },
    { key: 'auto.components.settings.agents.search.c64059f50d', fallback: 'prompt' },
    { key: 'auto.components.settings.agents.search.0d752916f8', fallback: 'hooks' },
    { key: 'auto.components.settings.agents.search.96ba2373b6', fallback: 'agent' },
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
