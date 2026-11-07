import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { UI_LANGUAGE_NATIVE_NAMES } from '../../../../../shared/ui-language'
import { SUPPORTED_UI_LOCALES } from '../../../../../shared/ui-locale'
import { normalizeWorkspaceTitleLanguage } from '../../../../../shared/workspace-title-language'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import { getWorkspaceTitleLanguageSearchEntry } from './auto-rename-branch-search'
import { translate } from '@/i18n/i18n'

export function WorkspaceTitleLanguageSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const entry = getWorkspaceTitleLanguageSearchEntry()
  return (
    <div className="@container">
      <SettingsRow
        label={entry.title}
        description={entry.description}
        className="flex-col items-stretch @xl:flex-row @xl:items-center"
        control={
          <Select
            value={normalizeWorkspaceTitleLanguage(settings.workspaceTitleLanguage)}
            disabled={!settings.autoRenameBranchFromWork}
            onValueChange={(value) =>
              updateSettings({ workspaceTitleLanguage: normalizeWorkspaceTitleLanguage(value) })
            }
          >
            <SelectTrigger size="sm" className="w-full @xl:min-w-52" aria-label={entry.title}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="branch">
                {translate(
                  'settings.sourceControl.workspaceTitleLanguage.branch',
                  'Same as branch name'
                )}
              </SelectItem>
              <SelectItem value="ui">
                {translate(
                  'settings.sourceControl.workspaceTitleLanguage.ui',
                  'Follow interface language'
                )}
              </SelectItem>
              {SUPPORTED_UI_LOCALES.map((locale) => (
                <SelectItem key={locale} value={locale}>
                  {UI_LANGUAGE_NATIVE_NAMES[locale]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
    </div>
  )
}
