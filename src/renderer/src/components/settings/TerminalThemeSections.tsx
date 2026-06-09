import type { Dispatch, SetStateAction } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { ColorField, ThemePicker } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { TerminalSettingsPreview } from './TerminalSettingsPreview'
import { translate } from '@/i18n/i18n'

type DarkTerminalThemeSectionProps = {
  settings: GlobalSettings
  systemPrefersDark: boolean
  themeSearchDark: string
  setThemeSearchDark: Dispatch<SetStateAction<string>>
  updateSettings: (updates: Partial<GlobalSettings>) => void
  previewFontFamily: string | null
}

type LightTerminalThemeSectionProps = {
  settings: GlobalSettings
  themeSearchLight: string
  setThemeSearchLight: Dispatch<SetStateAction<string>>
  updateSettings: (updates: Partial<GlobalSettings>) => void
  previewFontFamily: string | null
}

export function DarkTerminalThemeSection({
  settings,
  systemPrefersDark,
  themeSearchDark,
  setThemeSearchDark,
  updateSettings,
  previewFontFamily
}: DarkTerminalThemeSectionProps): React.JSX.Element {
  return (
    <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-6">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{translate("auto.components.settings.TerminalThemeSections.9499ad1dc4", "Dark Theme")}</h3>
          <p className="text-xs text-muted-foreground">
            {translate("auto.components.settings.TerminalThemeSections.f012172e21", "Choose the theme used for terminal panes in dark mode.")}</p>
        </div>

        <SearchableSetting
          title={translate("auto.components.settings.TerminalThemeSections.9499ad1dc4", "Dark Theme")}
          description={translate("auto.components.settings.TerminalThemeSections.7add204bd5", "Choose the terminal theme used in dark mode.")}
          keywords={['terminal', 'theme', 'dark', 'preview']}
        >
          <ThemePicker
            label={translate("auto.components.settings.TerminalThemeSections.9499ad1dc4", "Dark Theme")}
            description={translate("auto.components.settings.TerminalThemeSections.7add204bd5", "Choose the terminal theme used in dark mode.")}
            selectedTheme={settings.terminalThemeDark}
            query={themeSearchDark}
            onQueryChange={setThemeSearchDark}
            onSelectTheme={(theme) => updateSettings({ terminalThemeDark: theme })}
          />
        </SearchableSetting>

        <SearchableSetting
          title={translate("auto.components.settings.TerminalThemeSections.b739d2abfe", "Dark Divider Color")}
          description={translate("auto.components.settings.TerminalThemeSections.cbe56a0f79", "Controls the split divider line between panes in dark mode.")}
          keywords={['terminal', 'divider', 'dark', 'color']}
        >
          <ColorField
            label={translate("auto.components.settings.TerminalThemeSections.b739d2abfe", "Dark Divider Color")}
            description={translate("auto.components.settings.TerminalThemeSections.cbe56a0f79", "Controls the split divider line between panes in dark mode.")}
            value={settings.terminalDividerColorDark}
            fallback="#3f3f46"
            onChange={(value) => updateSettings({ terminalDividerColorDark: value })}
          />
        </SearchableSetting>
      </div>

      <TerminalSettingsPreview
        title={translate("auto.components.settings.TerminalThemeSections.bc8e8a251a", "Dark Mode Preview")}
        settings={settings}
        systemPrefersDark={systemPrefersDark}
        previewFontFamily={previewFontFamily}
        modeOverride="dark"
      />
    </section>
  )
}

export function LightTerminalThemeSection({
  settings,
  themeSearchLight,
  setThemeSearchLight,
  updateSettings,
  previewFontFamily
}: LightTerminalThemeSectionProps): React.JSX.Element {
  return (
    <section className="space-y-4">
      <SearchableSetting
        title={translate("auto.components.settings.TerminalThemeSections.d76f60c9cc", "Use Separate Theme In Light Mode")}
        description={translate("auto.components.settings.TerminalThemeSections.b584287e84", "When disabled, light mode reuses the dark terminal theme.")}
        keywords={['terminal', 'light mode', 'theme']}
        className="flex items-center justify-between gap-4 py-2"
      >
        <div className="space-y-0.5">
          <p className="text-sm font-medium">{translate("auto.components.settings.TerminalThemeSections.d76f60c9cc", "Use Separate Theme In Light Mode")}</p>
          <p className="text-xs text-muted-foreground">
            {translate("auto.components.settings.TerminalThemeSections.b584287e84", "When disabled, light mode reuses the dark terminal theme.")}</p>
        </div>
        <button
          role="switch"
          aria-checked={settings.terminalUseSeparateLightTheme}
          onClick={() =>
            updateSettings({
              terminalUseSeparateLightTheme: !settings.terminalUseSeparateLightTheme
            })
          }
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
            settings.terminalUseSeparateLightTheme ? 'bg-foreground' : 'bg-muted-foreground/30'
          }`}
        >
          <span
            className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
              settings.terminalUseSeparateLightTheme ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </SearchableSetting>

      {settings.terminalUseSeparateLightTheme ? (
        <div className="grid overflow-hidden pt-2">
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="space-y-6">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold">{translate("auto.components.settings.TerminalThemeSections.8273bc75d7", "Light Theme")}</h3>
                <p className="text-xs text-muted-foreground">
                  {translate("auto.components.settings.TerminalThemeSections.74b15574c8", "Configure the optional light-mode terminal appearance.")}</p>
              </div>

              <SearchableSetting
                title={translate("auto.components.settings.TerminalThemeSections.8273bc75d7", "Light Theme")}
                description={translate("auto.components.settings.TerminalThemeSections.d56af60e6f", "Choose the theme used when Orca is in light mode.")}
                keywords={['terminal', 'theme', 'light', 'preview']}
              >
                <ThemePicker
                  label={translate("auto.components.settings.TerminalThemeSections.8273bc75d7", "Light Theme")}
                  description={translate("auto.components.settings.TerminalThemeSections.d56af60e6f", "Choose the theme used when Orca is in light mode.")}
                  selectedTheme={settings.terminalThemeLight}
                  query={themeSearchLight}
                  onQueryChange={setThemeSearchLight}
                  onSelectTheme={(theme) => updateSettings({ terminalThemeLight: theme })}
                />
              </SearchableSetting>

              <SearchableSetting
                title={translate("auto.components.settings.TerminalThemeSections.ec2e33ad80", "Light Divider Color")}
                description={translate("auto.components.settings.TerminalThemeSections.5e0c24b5c8", "Controls the split divider line between panes in light mode.")}
                keywords={['terminal', 'divider', 'light', 'color']}
              >
                <ColorField
                  label={translate("auto.components.settings.TerminalThemeSections.ec2e33ad80", "Light Divider Color")}
                  description={translate("auto.components.settings.TerminalThemeSections.5e0c24b5c8", "Controls the split divider line between panes in light mode.")}
                  value={settings.terminalDividerColorLight}
                  fallback="#d4d4d8"
                  onChange={(value) => updateSettings({ terminalDividerColorLight: value })}
                />
              </SearchableSetting>
            </div>

            <TerminalSettingsPreview
              title={translate("auto.components.settings.TerminalThemeSections.db210115c5", "Light Mode Preview")}
              settings={settings}
              systemPrefersDark={false}
              previewFontFamily={previewFontFamily}
              modeOverride="light"
            />
          </div>
        </div>
      ) : null}
    </section>
  )
}
