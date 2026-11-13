import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { useResolvedWindowTitle } from '../../../app-shell/use-window-title'
import { DEFAULT_WINDOW_TITLE_TEMPLATE } from '../../../lib/window-title-template'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsRow, SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { DebouncedSettingsTextInput } from '../form-controls/DebouncedSettingsTextInput'
import { getWindowTitleEntries } from './appearance-window-title-search'
import { useTranslate } from '@/i18n/use-translate'

/** Opt-in switch plus a template field that previews the live title. */
export function WindowTitleSetting({
  settings,
  updateSettings
}: {
  settings: Pick<GlobalSettings, 'showWorkspaceInWindowTitle' | 'windowTitle'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const t = useTranslate()
  const entry = getWindowTitleEntries()[0]
  const enabled = settings.showWorkspaceInWindowTitle === true
  const templateLabel = t('settings.appearance.windowTitle.templateLabel', 'Title template')
  const currentTitle = useResolvedWindowTitle()
  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
    >
      <SettingsSwitchRow
        label={entry.title}
        description={entry.description}
        checked={enabled}
        onChange={() => updateSettings({ showWorkspaceInWindowTitle: !enabled })}
      />
      {enabled ? (
        <div className="ml-4 border-t border-border/40">
          <SettingsRow
            label={templateLabel}
            description={
              <>
                {t(
                  'settings.appearance.windowTitle.templateDescription',
                  'Variables: {{variables}}. {{separator}} adds “ — ” only between filled parts. Leave empty for the default.',
                  {
                    variables: '${appName}, ${repo}, ${worktree}, ${branch}, ${issueKey}, ${tab}',
                    separator: '${separator}'
                  }
                )}
                <span className="block text-foreground">
                  {t('settings.appearance.windowTitle.preview', 'Current title: {{title}}', {
                    title: currentTitle
                  })}
                </span>
              </>
            }
            alignTop
            control={
              <DebouncedSettingsTextInput
                aria-label={templateLabel}
                value={settings.windowTitle ?? ''}
                commit={(windowTitle) => updateSettings({ windowTitle })}
                placeholder={DEFAULT_WINDOW_TITLE_TEMPLATE}
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                variant="code"
                density="compact"
                className="w-96"
              />
            }
          />
        </div>
      ) : null}
    </SearchableSetting>
  )
}
