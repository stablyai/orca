import { useAppStore } from '@/store'
import type { Repo } from '../../../../../shared/repo-types'
import type { AgentWorkspaceTrustDecision } from '../../../../../shared/agent-launch/permissions/agent-workspace-trust-decision'
import { agentWorkspaceTrustDecisionCopy as copy } from '../../agent-workspace-trust/agent-workspace-trust-decision-copy'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSegmentedControl } from '../form-controls/SettingsFormControls'
import type { SettingsSearchEntry } from '../search/settings-search'

export function getRepositoryAgentTrustSearchEntry(): SettingsSearchEntry {
  return {
    title: copy.settingTitle(),
    description: copy.settingDescription(),
    keywords: [copy.settingKeywordTrust(), copy.settingKeywordHooks()]
  }
}

export function RepositoryAgentTrustSection({
  repo,
  updateRepo,
  forceVisible = false
}: {
  repo: Repo
  updateRepo: (
    repoId: string,
    updates: Pick<Repo, 'agentWorkspaceTrust'>
  ) => void | Promise<boolean>
  forceVisible?: boolean
}): React.JSX.Element {
  const globalTrustEnabled = useAppStore(
    (state) => state.settings?.agentWorkspaceTrustEnabled !== false
  )
  const entry = getRepositoryAgentTrustSearchEntry()
  const value = repo.agentWorkspaceTrust ?? 'pre-trust'
  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={[repo.displayName, ...(entry.keywords ?? [])]}
      className="space-y-3"
      forceVisible={forceVisible}
    >
      <div className="space-y-1">
        <div className="text-sm font-semibold">{entry.title}</div>
        <p className="text-xs text-muted-foreground">{entry.description}</p>
      </div>
      <SettingsSegmentedControl<AgentWorkspaceTrustDecision>
        value={value}
        onChange={(next) => {
          if (next !== value) {
            void updateRepo(repo.id, { agentWorkspaceTrust: next })
          }
        }}
        ariaLabel={entry.title}
        size="sm"
        options={[
          { value: 'pre-trust', label: copy.trustRepository() },
          { value: 'agent-asks', label: copy.letAgentsAsk() }
        ]}
      />
      {!globalTrustEnabled ? (
        <p className="text-xs text-muted-foreground">{copy.settingGlobalOff()}</p>
      ) : null}
    </SearchableSetting>
  )
}
