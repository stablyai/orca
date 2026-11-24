// @protected-copy: folder trust setting copy.
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { searchKeywords } from '../../search/settings-search-keywords'

export function getAgentWorkspaceTrustTitle(t: Translate = translate): string {
  return t(
    'auto.components.settings.agent-workspace-trust-copy.title',
    'Trust the folder when Orca starts an agent'
  )
}

export function getAgentWorkspaceTrustDescription(t: Translate = translate): string {
  return t(
    'auto.components.settings.agent-workspace-trust-copy.description',
    'Agents Orca starts can skip their "Do you trust this folder?" prompt, so the project\'s agent hooks and settings run right away. You can turn this off for one repository in that repository\'s settings. Turn this off to let agents always ask. An agent that asks while running without you watching, such as an orchestration worker, an automation or an agent started from your phone, waits until you answer in its terminal. Folders already trusted stay trusted.'
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
