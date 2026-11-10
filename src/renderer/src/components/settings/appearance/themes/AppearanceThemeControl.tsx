import type React from 'react'
import { Loader2, Store, Zap } from 'lucide-react'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import type { PluginThemeRegistration } from '../../../../../../shared/plugins/artifacts/plugin-theme-artifact'
import {
  editorThemeSlotUpdate,
  MATCH_TERMINAL_APP_THEME,
  pluginAppThemeSlotUpdate
} from '../../../../../../shared/plugin-theme-settings'
import { Button } from '../../../ui/button'
import {
  SettingsSearchableSelect,
  type SettingsSearchableSelectAction,
  type SettingsSearchableSelectGroup
} from '../../form-controls/SettingsSearchableSelect'
import { SettingsSegmentedControl } from '../../form-controls/SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { usePluginTerminalThemes, usePluginThemes } from '@/store/plugins/appearance/plugin-themes'
import { PluginThemeSwatch, ThemeColorSwatch } from '../../../plugins/page/PluginThemeSwatch'
import {
  isPluginTerminalThemeSelected,
  terminalThemeUpdate
} from '../../../plugins/state/plugin-theme-apply'
import { findCodeEditorTheme } from '@/lib/editor/appearance/code-editor-theme'
import { isWebClientLocation } from '@/lib/web-client-location'
import { requestPluginBrowse } from '@/store/plugins/navigation/plugin-preview-request'
import { useCatalogAppThemes, type CatalogAppTheme } from './use-catalog-app-themes'
import {
  disambiguatedContentPluginNames,
  disambiguatedPluginContentLabels
} from '../../../plugins/presentation/plugin-name-disambiguation'

type BuiltInTheme = GlobalSettings['theme']

const BUILT_IN = 'built-in'
const FOLLOW_APP = 'follow-app'

function browseThemesLabel(t: Translate = translate): string {
  return t('auto.components.settings.AppearanceThemeControl.browseThemes', 'Browse themes')
}

function builtInLabel(t: Translate = translate): string {
  return t(
    'auto.components.settings.AppearanceInterfaceSection.pluginIconTheme.builtIn',
    'Built-in'
  )
}

function searchThemesLabel(t: Translate = translate): string {
  return t('auto.components.settings.AppearanceThemeControl.searchThemes', 'Search themes…')
}

function noThemesLabel(t: Translate = translate): string {
  return t(
    'auto.components.settings.AppearanceThemeControl.noThemes',
    'No themes match your search.'
  )
}

/** Desktop only: the web client has no plugin catalog to open. */
function browseThemesActions(t?: Translate): SettingsSearchableSelectAction[] {
  return isWebClientLocation()
    ? []
    : [
        {
          key: 'browse-themes',
          label: browseThemesLabel(t),
          icon: <Store className="size-3.5" />,
          onSelect: () => requestPluginBrowse('themes')
        }
      ]
}

/** `labels` holds every theme the picker lists, so two sharing a name show their publishers. */
function pluginThemeGroups(
  themes: readonly PluginThemeRegistration[],
  labels: ReadonlyMap<string, string> = themeOptionLabels(themes),
  t?: Translate
): SettingsSearchableSelectGroup[] {
  const pluginNames = disambiguatedContentPluginNames(themes, t)
  return [...Map.groupBy(themes, (theme) => theme.pluginKey).values()].map((group) => ({
    key: group[0].pluginKey,
    heading: pluginNames.get(group[0].pluginKey) ?? group[0].pluginName,
    options: group.map((theme) => ({
      value: theme.id,
      label: labels.get(theme.id) ?? theme.label,
      keywords: [theme.base],
      icon: <PluginThemeSwatch theme={theme} />
    }))
  }))
}

function themeOptionLabels(
  themes: readonly PluginThemeRegistration[],
  catalogThemes: readonly CatalogAppTheme[] = [],
  t?: Translate
): ReadonlyMap<string, string> {
  return disambiguatedPluginContentLabels(
    [
      ...themes,
      ...catalogThemes.map((theme) => ({
        id: theme.value,
        pluginKey: theme.listing.pluginKey,
        label: theme.label
      }))
    ],
    undefined,
    t
  )
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
  const t = useTranslate()
  return (
    <div className="flex items-center gap-2">
      {/* Why desktop only: the web client has no plugin catalog to open. */}
      {isWebClientLocation() ? null : (
        <Button variant="outline" size="sm" onClick={() => requestPluginBrowse('themes')}>
          <Store />
          {browseThemesLabel(t)}
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
            label: t('auto.components.settings.AppearancePane.fb0e0b4453', 'System')
          },
          {
            value: 'dark',
            label: t('auto.components.settings.AppearancePane.7d26ccabe8', 'Dark')
          },
          {
            value: 'light',
            label: t('auto.components.settings.AppearancePane.fd89b5487c', 'Light')
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
  const t = useTranslate()
  const allThemes = usePluginThemes()
  const themes = allThemes.filter((theme) => theme.base === base)
  const catalog = useCatalogAppThemes(base, allThemes, settings.pluginSystemEnabled === true)
  const pluginTerminalThemes = usePluginTerminalThemes()
  const selectedId = base === 'dark' ? settings.pluginAppThemeDark : settings.pluginAppThemeLight
  const active = themes.find((theme) => theme.id === selectedId)
  const value =
    selectedId === MATCH_TERMINAL_APP_THEME ? MATCH_TERMINAL_APP_THEME : (active?.id ?? BUILT_IN)
  const terminal = active
    ? pluginTerminalThemes.find(
        (theme) =>
          theme.pluginKey === active.pluginKey && (theme.mode === base || theme.mode === 'unknown')
      )
    : undefined
  const terminalInUse =
    terminal !== undefined && isPluginTerminalThemeSelected(settings, terminal, base === 'dark')
  const labels = themeOptionLabels(themes, catalog.themes, t)
  return (
    <div className="flex flex-col items-end gap-1">
      <SettingsSearchableSelect
        ariaLabel={label}
        value={value}
        searchPlaceholder={searchThemesLabel(t)}
        emptyText={noThemesLabel(t)}
        onOpenChange={(open) => {
          if (open) {
            catalog.open()
          }
        }}
        onValueChange={(next) => {
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
        groups={[
          {
            key: BUILT_IN,
            options: [
              { value: BUILT_IN, label: builtInLabel(t) },
              {
                value: MATCH_TERMINAL_APP_THEME,
                label: t(
                  'auto.components.settings.AppearanceThemeControl.7ad388ec82',
                  'Match terminal'
                ),
                detail: (
                  <>
                    <Zap className="mr-1 size-3" aria-hidden />
                    {t('auto.components.settings.AppearanceThemeControl.dynamic', 'dynamic')}
                  </>
                )
              }
            ]
          },
          ...pluginThemeGroups(themes, labels, t),
          {
            key: 'catalog',
            heading: t('auto.components.settings.AppearanceThemeControl.moreThemes', 'More themes'),
            options: catalog.themes.map((theme) => ({
              value: theme.value,
              label: labels.get(theme.value) ?? theme.label,
              keywords: [theme.pluginName],
              disabled: catalog.installing !== null,
              icon: <ThemeColorSwatch background={theme.background} accent={theme.accent} />
            }))
          }
        ]}
        status={
          catalog.loading ? (
            <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
              {t(
                'auto.components.settings.AppearanceThemeControl.moreThemesLoading',
                'Loading themes…'
              )}
            </div>
          ) : null
        }
        actions={browseThemesActions(t)}
      />
      {catalog.installing ? (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
          {t(
            'auto.components.settings.AppearanceThemeControl.installingTheme',
            'Installing {{value0}}…',
            { value0: labels.get(catalog.installing.value) ?? catalog.installing.label }
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
          {t(
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
  const t = useTranslate()
  const themes = usePluginThemes()
  const selected = findCodeEditorTheme(
    base === 'dark' ? settings.editorThemeDark : settings.editorThemeLight,
    themes
  )
  return (
    <SettingsSearchableSelect
      ariaLabel={label}
      value={selected === null ? FOLLOW_APP : typeof selected === 'string' ? selected : selected.id}
      searchPlaceholder={searchThemesLabel(t)}
      emptyText={noThemesLabel(t)}
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
      groups={[
        {
          key: FOLLOW_APP,
          options: [
            {
              value: FOLLOW_APP,
              label: t('settings.appearance.editorTheme.followApp', 'Same as app theme')
            }
          ]
        },
        {
          key: BUILT_IN,
          heading: builtInLabel(t),
          options: [
            {
              value: 'light',
              label: t('auto.components.settings.AppearancePane.fd89b5487c', 'Light')
            },
            {
              value: 'dark',
              label: t('auto.components.settings.AppearancePane.7d26ccabe8', 'Dark')
            }
          ]
        },
        ...pluginThemeGroups(themes, undefined, t)
      ]}
    />
  )
}
