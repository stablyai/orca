import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { Switch } from '../../ui/switch'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import { matchesSettingsSearch } from '../search/settings-search'

export const LINKED_REPOSITORIES_KEYWORDS = [
  'linked repositories',
  'linked repos',
  'other projects',
  'multi repo',
  'cross repo',
  'agent changes',
  'source control'
]

export function getLinkedRepositoriesTitle(): string {
  return translate(
    'auto.components.settings.GitPane.linkedRepositoriesTitle',
    'Linked Repositories'
  )
}

export function getLinkedRepositoriesDescription(): string {
  return translate(
    'auto.components.settings.GitPane.linkedRepositoriesDescription',
    "When an agent changes files in another project you've added to Orca, show that project in this workspace's Source Control so you can review and commit it there."
  )
}

export function linkedRepositoriesMatchesSearch(searchQuery: string): boolean {
  return matchesSettingsSearch(searchQuery, {
    title: getLinkedRepositoriesTitle(),
    description: getLinkedRepositoriesDescription(),
    keywords: LINKED_REPOSITORIES_KEYWORDS
  })
}

export function LinkedRepositoriesSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const title = getLinkedRepositoriesTitle()
  const description = getLinkedRepositoriesDescription()

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={LINKED_REPOSITORIES_KEYWORDS}
      className="max-w-none"
    >
      <SettingsRow
        label={title}
        description={description}
        alignTop
        control={
          <Switch
            aria-label={title}
            checked={settings.linkedRepositoriesEnabled !== false}
            onCheckedChange={(checked) => {
              void updateSettings({ linkedRepositoriesEnabled: checked })
            }}
          />
        }
      />
    </SearchableSetting>
  )
}
