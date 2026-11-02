import type React from 'react'
import { Loader2, Store, Zap } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  editorThemeSlotUpdate,
  MATCH_TERMINAL_APP_THEME,
  pluginAppThemeSlotUpdate
} from '../../../../shared/plugin-theme-settings'
import { Button } from '../ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '../ui/select'
import { SettingsSegmentedControl } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { usePluginTerminalThemes, usePluginThemes } from '@/store/plugin-themes'
import { PluginThemeSwatch, ThemeColorSwatch } from '../plugins/page/PluginThemeSwatch'
import {
  isPluginTerminalThemeSelected,
  terminalThemeUpdate
} from '../plugins/state/plugin-theme-apply'
import { findCodeEditorTheme } from '@/lib/code-editor-theme'
import { isWebClientLocation } from '@/lib/web-client-location'
import { requestPluginBrowse } from '@/store/plugin-preview-request'
import { useCatalogAppThemes } from './use-catalog-app-themes'

type BuiltInTheme = GlobalSettings['theme']

const BUILT_IN = 'built-in'
const FOLLOW_APP = 'follow-app'
const BROWSE_THEMES = 'browse-themes'

function browseThemesLabel(): string {
  return translate('auto.components.settings.AppearanceThemeControl.browseThemes', 'Browse themes')
}

/** System, Dark or Light; the Light theme and Dark theme slots pick the colors for each. */
export function AppearanceThemeControl({
  label,
  settings,
  updateSettings,
  applyTheme
}: {
  label: string
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  applyTheme: (theme: BuiltInTheme) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      {/* Why desktop only: the web client has no plugin catalog to open. */}
      {isWebClientLocation() ? null : (
        <Button variant="outline" size="sm" onClick={() => requestPluginBrowse('themes')}>
          <Store />
          {browseThemesLabel()}
        </Button>
      )}
      <SettingsSegmentedControl
        ariaLabel={label}
        value={settings.theme}
        onChange={(theme) => {
          updateSettings({ theme })
          applyTheme(theme)
        }}
        options={[
          {
            value: 'system',
            label: translate('auto.components.settings.AppearancePane.fb0e0b4453', 'System')
          },
          {
            value: 'dark',
            label: translate('auto.components.settings.AppearancePane.7d26ccabe8', 'Dark')
          },
          {
            value: 'light',
            label: translate('auto.components.settings.AppearancePane.fd89b5487c', 'Light')
          }
        ]}
      />
    </div>
  )
}

/** The app theme painted while Orca is in one mode: built-in, the terminal's colors, or any
 *  enabled plugin theme of that mode. */
export function AppearanceThemeSlotSelect({
  base,
  label,
  settings,
  updateSettings
}: {
  base: 'light' | 'dark'
  label: string
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const allThemes = usePluginThemes()
  const themes = allThemes.filter((theme) => theme.base === base)
  const catalog = useCatalogAppThemes(base, allThemes, settings.pluginSystemEnabled === true)
  const pluginTerminalThemes = usePluginTerminalThemes()
  const selectedId = base === 'dark' ? settings.pluginAppThemeDark : settings.pluginAppThemeLight
  const active = themes.find((theme) => theme.id === selectedId)
  const value =
    selectedId === MATCH_TERMINAL_APP_THEME ? MATCH_TERMINAL_APP_THEME : (active?.id ?? BUILT_IN)
  const groups = Map.groupBy(themes, (theme) => theme.pluginKey)
  const terminal = active
    ? pluginTerminalThemes.find(
        (theme) =>
          theme.pluginKey === active.pluginKey && (theme.mode === base || theme.mode === 'unknown')
      )
    : undefined
  const terminalInUse =
    terminal !== undefined && isPluginTerminalThemeSelected(settings, terminal, base === 'dark')
  return (
    <div className="flex flex-col items-end gap-1">
      <Select
        value={value}
        onOpenChange={(open) => {
          if (open) {
            catalog.open()
          }
        }}
        onValueChange={(next) => {
          if (next === BROWSE_THEMES) {
            requestPluginBrowse('themes')
            return
          }
          if (catalog.pick(next)) {
            return
          }
          updateSettings(
            pluginAppThemeSlotUpdate(
              base,
              next === MATCH_TERMINAL_APP_THEME
                ? MATCH_TERMINAL_APP_THEME
                : (themes.find((theme) => theme.id === next)?.id ?? null)
            )
          )
        }}
      >
        <SelectTrigger size="sm" className="min-w-[220px]" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={BUILT_IN}>
            {translate(
              'auto.components.settings.AppearanceInterfaceSection.pluginIconTheme.builtIn',
              'Built-in'
            )}
          </SelectItem>
          <SelectItem value={MATCH_TERMINAL_APP_THEME}>
            {translate(
              'auto.components.settings.AppearanceThemeControl.matchTerminal',
              'Match Terminal'
            )}
            <span className="flex items-center text-xs text-muted-foreground">
              (<Zap className="mr-1 size-3" aria-hidden />
              {translate('auto.components.settings.AppearanceThemeControl.dynamic', 'dynamic')})
            </span>
          </SelectItem>
          {[...groups.values()].map((group) => (
            <SelectGroup key={group[0].pluginKey}>
              <SelectLabel>{group[0].pluginName}</SelectLabel>
              {group.map((theme) => (
                <SelectItem key={theme.id} value={theme.id}>
                  <PluginThemeSwatch theme={theme} />
                  {theme.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
          {catalog.themes.length > 0 || catalog.loading ? (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>
                  {translate(
                    'auto.components.settings.AppearanceThemeControl.moreThemes',
                    'More themes'
                  )}
                </SelectLabel>
                {catalog.loading ? (
                  <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
                    {translate(
                      'auto.components.settings.AppearanceThemeControl.moreThemesLoading',
                      'Loading themes…'
                    )}
                  </div>
                ) : null}
                {catalog.themes.map((theme) => (
                  <SelectItem
                    key={theme.value}
                    value={theme.value}
                    disabled={catalog.installing !== null}
                  >
                    <ThemeColorSwatch background={theme.background} accent={theme.accent} />
                    {theme.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          ) : null}
          {isWebClientLocation() ? null : (
            <>
              <SelectSeparator />
              <SelectItem value={BROWSE_THEMES}>
                <Store className="size-3.5" />
                {browseThemesLabel()}
              </SelectItem>
            </>
          )}
        </SelectContent>
      </Select>
      {catalog.installing ? (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
          {translate(
            'auto.components.settings.AppearanceThemeControl.installingTheme',
            'Installing {{value0}}…',
            { value0: catalog.installing.label }
          )}
        </span>
      ) : null}
      {catalog.error ? (
        <span role="alert" className="text-xs text-destructive">
          {catalog.error}
        </span>
      ) : null}
      {terminal && !terminalInUse ? (
        <Button
          variant="link"
          size="xs"
          onClick={() =>
            updateSettings(
              terminalThemeUpdate(settings, terminal, base === 'dark', pluginTerminalThemes)
            )
          }
        >
          {translate(
            'auto.components.settings.AppearanceThemeControl.useTerminalTheme',
            'Use its terminal colors'
          )}
        </Button>
      ) : null}
    </div>
  )
}

/** One mode's code editor theme: the app's, built-in light or dark, or any plugin app theme. */
export function CodeEditorThemeSelect({
  base,
  label,
  settings,
  updateSettings
}: {
  base: 'light' | 'dark'
  label: string
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const themes = usePluginThemes()
  const selected = findCodeEditorTheme(
    base === 'dark' ? settings.editorThemeDark : settings.editorThemeLight,
    themes
  )
  const groups = Map.groupBy(themes, (theme) => theme.pluginKey)
  return (
    <Select
      value={selected === null ? FOLLOW_APP : typeof selected === 'string' ? selected : selected.id}
      onValueChange={(value) =>
        updateSettings(
          editorThemeSlotUpdate(
            base,
            value === 'light' || value === 'dark'
              ? value
              : (themes.find((theme) => theme.id === value)?.id ?? null)
          )
        )
      }
    >
      <SelectTrigger size="sm" className="min-w-[220px]" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={FOLLOW_APP}>
          {translate('settings.appearance.editorTheme.followApp', 'Same as app theme')}
        </SelectItem>
        <SelectGroup>
          <SelectLabel>
            {translate(
              'auto.components.settings.AppearanceInterfaceSection.pluginIconTheme.builtIn',
              'Built-in'
            )}
          </SelectLabel>
          <SelectItem value="light">
            {translate('auto.components.settings.AppearancePane.fd89b5487c', 'Light')}
          </SelectItem>
          <SelectItem value="dark">
            {translate('auto.components.settings.AppearancePane.7d26ccabe8', 'Dark')}
          </SelectItem>
        </SelectGroup>
        {[...groups.values()].map((group) => (
          <SelectGroup key={group[0].pluginKey}>
            <SelectLabel>{group[0].pluginName}</SelectLabel>
            {group.map((theme) => (
              <SelectItem key={theme.id} value={theme.id}>
                <PluginThemeSwatch theme={theme} />
                {theme.label}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}
