import { List } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { Button } from '../../ui/button'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { getWorkspaceCleanupSettingsSearchParts } from './workspace-cleanup-settings-search'

/** Deleting workspaces by hand, whether or not any rule is on. */
export function WorkspaceCleanupManualSection(): React.JSX.Element {
  const t = useTranslate()
  const openModal = useAppStore((state) => state.openModal)
  const search = getWorkspaceCleanupSettingsSearchParts()
  return (
    <SettingsGroup title={t('components.settings.workspaceCleanup.manual.title', 'Manual cleanup')}>
      <SearchableSetting {...search.review} className="@container">
        <SettingsRow
          label={t(
            'components.settings.workspaceCleanup.manual.label',
            'Delete workspaces you pick'
          )}
          description={search.review.description}
          // A narrow pane puts the button under the text.
          className="flex-col items-start @[25rem]:flex-row @[25rem]:items-center"
          control={
            <Button variant="secondary" size="sm" onClick={() => openModal('workspace-cleanup')}>
              <List className="size-3.5" />
              {search.review.title}
            </Button>
          }
        />
      </SearchableSetting>
    </SettingsGroup>
  )
}
