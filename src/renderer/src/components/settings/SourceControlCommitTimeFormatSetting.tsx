import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { SourceControlCommitTimeFormat } from '../../../../shared/ui-chrome-types'
import { normalizeSourceControlCommitTimeFormat } from '../../../../shared/source-control-commit-time-format'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'
import { matchesSettingsSearch } from './settings-search'

export const COMMIT_TIME_FORMAT_KEYWORDS = [
  'commit time',
  'commit date',
  'timestamp',
  'when committed',
  'time distribution',
  'relative',
  'absolute',
  'git history',
  'commit list',
  'source control'
]

function getCommitTimeFormatTitle(): string {
  return translate('auto.components.settings.GitPane.commitTimeFormatTitle', 'Commit Time Column')
}

function getCommitTimeFormatDescription(): string {
  return translate(
    'auto.components.settings.GitPane.commitTimeFormatDescription',
    'Show the date and time of each commit in the Git history list, so you can scan how commits are spread over time without expanding them. Hover a commit for its exact time to the second.'
  )
}

export function commitTimeFormatMatchesSearch(searchQuery: string): boolean {
  return matchesSettingsSearch(searchQuery, {
    title: getCommitTimeFormatTitle(),
    description: getCommitTimeFormatDescription(),
    keywords: COMMIT_TIME_FORMAT_KEYWORDS
  })
}

export function SourceControlCommitTimeFormatSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const title = getCommitTimeFormatTitle()
  const description = getCommitTimeFormatDescription()
  const value = normalizeSourceControlCommitTimeFormat(settings.sourceControlCommitTimeFormat)

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={COMMIT_TIME_FORMAT_KEYWORDS}
      className="max-w-none"
    >
      <SettingsRow
        label={title}
        description={description}
        alignTop
        control={
          <SettingsSegmentedControl<SourceControlCommitTimeFormat>
            value={value}
            onChange={(nextValue) => {
              if (nextValue !== value) {
                void updateSettings({ sourceControlCommitTimeFormat: nextValue })
              }
            }}
            ariaLabel={title}
            size="sm"
            options={[
              {
                value: 'hidden',
                label: translate(
                  'auto.components.settings.GitPane.commitTimeFormatHidden',
                  'Hidden'
                )
              },
              {
                value: 'relative',
                label: translate(
                  'auto.components.settings.GitPane.commitTimeFormatRelative',
                  'Relative'
                )
              },
              {
                value: 'absolute',
                label: translate(
                  'auto.components.settings.GitPane.commitTimeFormatAbsolute',
                  'Absolute'
                )
              }
            ]}
          />
        }
      />
    </SearchableSetting>
  )
}
