import type React from 'react'

import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { AppearanceChromeMock } from './appearance-chrome-mock'
import { TerminalSettingsPreview } from './TerminalSettingsPreview'
import type { TerminalThemeTarget } from './TerminalThemeSections'

type AppearancePreviewColumnProps = {
  settings: GlobalSettings
  systemPrefersDark: boolean
  previewFontFamily?: string | null
  terminalPreviewMode: TerminalThemeTarget
  onTerminalPreviewModeChange: (mode: TerminalThemeTarget) => void
}

function resolvePreviewTheme(
  settings: Pick<GlobalSettings, 'theme'>,
  systemPrefersDark: boolean
): 'dark' | 'light' {
  return settings.theme === 'system' ? (systemPrefersDark ? 'dark' : 'light') : settings.theme
}

export function AppearancePreviewColumn({
  settings,
  systemPrefersDark,
  previewFontFamily,
  terminalPreviewMode,
  onTerminalPreviewModeChange
}: AppearancePreviewColumnProps): React.JSX.Element {
  const statusBarItems = useAppStore((state) => state.statusBarItems)
  const previewTheme = resolvePreviewTheme(settings, systemPrefersDark)

  return (
    <aside
      className="order-first w-full shrink-0 scrollbar-sleek lg:order-none lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto lg:pr-1"
      aria-label={translate(
        'auto.components.settings.AppearancePreviewColumn.label',
        'Appearance preview'
      )}
    >
      <div className="mb-3 space-y-1">
        <h3 className="text-sm font-medium">
          {translate(
            'auto.components.settings.AppearancePreviewColumn.visibleTitle',
            'Live preview'
          )}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.AppearancePreviewColumn.visibleDescription',
            'Updates as you edit.'
          )}
        </p>
      </div>
      <div
        className={`${previewTheme === 'dark' ? 'dark' : 'theme-light'} space-y-4 rounded-xl bg-background text-foreground`}
        data-preview-theme={previewTheme}
      >
        <AppearanceChromeMock
          settings={settings}
          systemPrefersDark={systemPrefersDark}
          statusBarItems={statusBarItems}
        />
        <TerminalSettingsPreview
          title={translate(
            'auto.components.settings.AppearancePreviewColumn.terminalTitle',
            'Terminal preview'
          )}
          description={translate(
            'auto.components.settings.AppearancePreviewColumn.terminalDraftDescription',
            'Drafted terminal appearance. Compare dark and light themes.'
          )}
          settings={settings}
          systemPrefersDark={systemPrefersDark}
          previewFontFamily={previewFontFamily}
          modeOverride={terminalPreviewMode}
          onModeOverrideChange={onTerminalPreviewModeChange}
          showThemeToggle
        />
      </div>
    </aside>
  )
}
