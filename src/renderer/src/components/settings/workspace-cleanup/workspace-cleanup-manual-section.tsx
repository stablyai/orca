import { List } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { Button } from '../../ui/button'
import { Label } from '../../ui/label'
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
      <SearchableSetting {...search.review}>
        {/* The text keeps a minimum width, so a narrow pane wraps the button under it. */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
          <div className="min-w-[min(15rem,100%)] flex-1 space-y-1">
            <Label className="select-text">
              {t('components.settings.workspaceCleanup.manual.label', 'Delete workspaces you pick')}
            </Label>
            <p className="select-text text-xs text-muted-foreground">{search.review.description}</p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => openModal('workspace-cleanup')}>
            <List className="size-3.5" />
            {search.review.title}
          </Button>
        </div>
      </SearchableSetting>
    </SettingsGroup>
  )
}
