import type { GlobalSettings, SourceControlGroupOrder } from '../../../../shared/types'
import { DEFAULT_SOURCE_CONTROL_GROUP_ORDER } from '../../../../shared/source-control-group-order'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'
import { matchesSettingsSearch } from './settings-search'

export const SOURCE_CONTROL_GROUP_ORDER_KEYWORDS = [
  'group order',
  'changes first',
  'staged first',
  'untracked first',
  'source control',
  'git changes'
]

function getSourceControlGroupOrderTitle(): string {
  return translate(
    'auto.components.settings.GitPane.sourceControlGroupOrderTitle',
    'Source Control Group Order'
  )
}

function getSourceControlGroupOrderDescription(): string {
  return translate(
    'auto.components.settings.GitPane.sourceControlGroupOrderDescription',
    'Choose whether Changes, Staged Changes, or Untracked Files appear first in Source Control.'
  )
}

export function sourceControlGroupOrderMatchesSearch(searchQuery: string): boolean {
  return matchesSettingsSearch(searchQuery, {
    title: getSourceControlGroupOrderTitle(),
    description: getSourceControlGroupOrderDescription(),
    keywords: SOURCE_CONTROL_GROUP_ORDER_KEYWORDS
  })
}

export function SourceControlGroupOrderSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const value = settings.sourceControlGroupOrder ?? DEFAULT_SOURCE_CONTROL_GROUP_ORDER
  const title = getSourceControlGroupOrderTitle()
  const description = getSourceControlGroupOrderDescription()

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={SOURCE_CONTROL_GROUP_ORDER_KEYWORDS}
      className="max-w-none"
    >
      <SettingsRow
        label={title}
        description={description}
        alignTop
        control={
          <SettingsSegmentedControl<SourceControlGroupOrder>
            value={value}
            onChange={(nextValue) => {
              if (nextValue !== value) {
                void updateSettings({ sourceControlGroupOrder: nextValue })
              }
            }}
            ariaLabel={title}
            size="sm"
            options={[
              {
                value: 'changes-first',
                label: translate('auto.components.settings.GitPane.changesFirst', 'Changes first')
              },
              {
                value: 'staged-first',
                label: translate('auto.components.settings.GitPane.stagedFirst', 'Staged first')
              },
              {
                value: 'untracked-first',
                label: translate(
                  'auto.components.settings.GitPane.untrackedFirst',
                  'Untracked first'
                )
              }
            ]}
          />
        }
      />
    </SearchableSetting>
  )
}
