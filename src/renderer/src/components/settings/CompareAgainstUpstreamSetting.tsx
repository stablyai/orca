import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'
import { matchesSettingsSearch } from './settings-search'

type SourceControlCompareBasePolicy = 'repository-default' | 'branch-upstream'

export const COMPARE_AGAINST_UPSTREAM_KEYWORDS = [
  'compare base',
  'default compare base',
  'default branch',
  'repository default',
  'branch upstream',
  'current branch',
  'upstream',
  'local changes',
  'origin/master',
  'committed changes',
  'diff base',
  'source control'
]

function getCompareAgainstUpstreamTitle(): string {
  return translate(
    'auto.components.settings.GitPane.compareAgainstUpstreamTitle',
    'Default Compare Base'
  )
}

function getCompareAgainstUpstreamDescription(): string {
  return translate(
    'auto.components.settings.GitPane.compareAgainstUpstreamDescription',
    "Choose which base Source Control uses by default for committed-change comparisons. Branch upstream follows the current branch automatically and falls back to the repository default branch when no upstream exists. You can still change the compare base per worktree from that worktree's Git panel. Pull Request and rebase targets don't change."
  )
}

export function compareAgainstUpstreamMatchesSearch(searchQuery: string): boolean {
  return matchesSettingsSearch(searchQuery, {
    title: getCompareAgainstUpstreamTitle(),
    description: getCompareAgainstUpstreamDescription(),
    keywords: COMPARE_AGAINST_UPSTREAM_KEYWORDS
  })
}

export function CompareAgainstUpstreamSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const title = getCompareAgainstUpstreamTitle()
  const description = getCompareAgainstUpstreamDescription()
  const value: SourceControlCompareBasePolicy = settings.sourceControlCompareAgainstUpstream
    ? 'branch-upstream'
    : 'repository-default'

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={COMPARE_AGAINST_UPSTREAM_KEYWORDS}
      className="max-w-none"
    >
      <SettingsRow
        label={title}
        description={description}
        alignTop
        control={
          <SettingsSegmentedControl<SourceControlCompareBasePolicy>
            value={value}
            onChange={(nextValue) => {
              if (nextValue !== value) {
                void updateSettings({
                  sourceControlCompareAgainstUpstream: nextValue === 'branch-upstream'
                })
              }
            }}
            ariaLabel={title}
            size="sm"
            options={[
              {
                value: 'repository-default',
                label: translate(
                  'auto.components.settings.GitPane.compareBaseRepositoryDefault',
                  'Repository default'
                )
              },
              {
                value: 'branch-upstream',
                label: translate(
                  'auto.components.settings.GitPane.compareBaseBranchUpstream',
                  'Branch upstream'
                )
              }
            ]}
          />
        }
      />
    </SearchableSetting>
  )
}
