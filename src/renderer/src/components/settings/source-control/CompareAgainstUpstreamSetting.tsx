import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from '../form-controls/SettingsFormControls'
import { matchesSettingsSearch } from '../search/settings-search'

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

function getCompareAgainstUpstreamTitle(t: Translate = translate): string {
  return t('auto.components.settings.GitPane.074f7aa0d6', 'Default compare base')
}

function getCompareAgainstUpstreamDescription(t: Translate = translate): string {
  return t(
    'auto.components.settings.GitPane.compareAgainstUpstreamDescription',
    "Choose which base Source Control uses by default for committed-change comparisons. Branch upstream follows the current branch automatically and falls back to the repository default branch when no upstream exists. You can still change the compare base per worktree from that worktree's Git panel. Pull Request and rebase targets don't change."
  )
}

export function compareAgainstUpstreamMatchesSearch(searchQuery: string, t?: Translate): boolean {
  return matchesSettingsSearch(searchQuery, {
    title: getCompareAgainstUpstreamTitle(t),
    description: getCompareAgainstUpstreamDescription(t),
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
  const t = useTranslate()
  const title = getCompareAgainstUpstreamTitle(t)
  const description = getCompareAgainstUpstreamDescription(t)
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
                label: t(
                  'auto.components.settings.GitPane.compareBaseRepositoryDefault',
                  'Repository default'
                )
              },
              {
                value: 'branch-upstream',
                label: t(
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
