import { useEffect, useState } from 'react'
import type {
  ClaudeManagedAccountSummary,
  Project,
  ProjectUpdateArgs
} from '../../../../shared/types'
import { SearchableSetting } from './SearchableSetting'
import type { SettingsSearchEntry } from './settings-search'
import { matchesSettingsSearch } from './settings-search'
import { ProjectClaudeAccountSetting } from './ProjectClaudeAccountSetting'
import { watchProviderAccounts } from '../../runtime/runtime-provider-accounts-client'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'

type RepositoryClaudeAccountSectionProps = {
  repoDisplayName: string
  project: Project | null
  updateProject?: (
    projectId: string,
    updates: ProjectUpdateArgs['updates']
  ) => void | Promise<unknown>
  forceVisible: boolean
  searchQuery: string
  searchEntries: SettingsSearchEntry[]
}

export function RepositoryClaudeAccountSection({
  repoDisplayName,
  project,
  updateProject,
  forceVisible,
  searchQuery,
  searchEntries
}: RepositoryClaudeAccountSectionProps): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const activeRuntimeEnvironmentId = settings?.activeRuntimeEnvironmentId
  const [accounts, setAccounts] = useState<ClaudeManagedAccountSummary[]>([])

  useEffect(() => {
    const watcher = watchProviderAccounts(
      { activeRuntimeEnvironmentId },
      {
        onSnapshot: (snapshot) => setAccounts(snapshot.claude.accounts),
        // Why: a load failure just hides the section; account errors surface in Settings > Accounts.
        onError: () => setAccounts([])
      }
    )
    return () => watcher.close()
  }, [activeRuntimeEnvironmentId])

  if (!project || !updateProject || accounts.length === 0) {
    return null
  }

  return (
    <SearchableSetting
      title={translate('auto.components.settings.RepositoryPane.claudeAccount', 'Claude Account')}
      description={translate(
        'auto.components.settings.RepositoryPane.claudeAccountDescription',
        'Choose which managed Claude account this project launches Claude Code with.'
      )}
      keywords={[repoDisplayName, 'claude', 'account', 'agent account', 'anthropic']}
      className="space-y-3"
      forceVisible={forceVisible || matchesSettingsSearch(searchQuery, searchEntries)}
    >
      <ProjectClaudeAccountSetting
        project={project}
        accounts={accounts}
        updateProject={updateProject}
      />
    </SearchableSetting>
  )
}
