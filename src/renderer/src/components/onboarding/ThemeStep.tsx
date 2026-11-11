import { useEffect, useState } from 'react'
import { ExternalLink, Puzzle, Settings2 } from 'lucide-react'
import { Trans } from 'react-i18next'
import { toast } from 'sonner'
import { track } from '@/diagnostics/telemetry/telemetry'
import { useMountedRef } from '@/hooks/useMountedRef'
import { GhosttyDiscoveryRow } from './GhosttyDiscoveryRow'
import { i18n, translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { ThemeSlotControl, useThemeLooks } from './ThemeLookGallery'
import { ThemeLookCarousel, openThemePluginDirectory } from './ThemeLookCarousel'
import { ThemeModeTiles } from './ThemeModeTiles'
import { themeLookSettingsUpdate } from './onboarding-theme-look-settings'
import { terminalConfigImportSettingsUpdate } from '../../../../shared/terminal/appearance/terminal-config-import-preview'
import type { TerminalConfigImportPreview } from '../../../../shared/terminal/appearance/terminal-config-import-preview'
import { getSystemPrefersDark } from '@/lib/terminal/appearance/terminal-theme'
import { useSystemPrefersDark } from '@/hooks/theme/use-system-prefers-dark'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { DiscoveryStatusEmitted } from '../../../../shared/onboarding-state-types'
import type { ThemeLook, ThemeLookBase } from './onboarding-theme-looks'

type ThemeStepProps = {
  theme: GlobalSettings['theme']
  onThemeChange: (theme: GlobalSettings['theme']) => void
  settings: GlobalSettings | null
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
  /** Settings as the step found them; each pick replaces only its own mode's slot from here. */
  lookBaseline: GlobalSettings | null
  onLookBaselineChange: (settings: GlobalSettings) => void
}

export function applyOnboardingThemeSelection(
  id: GlobalSettings['theme'],
  onThemeChange: (theme: GlobalSettings['theme']) => void,
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
): void {
  onThemeChange(id)
  // Persist immediately so later onboarding setting writes cannot reapply the old theme.
  void updateSettings({ theme: id })
}

// Idle/detecting emit no telemetry; other states match the guarded DiscoveryStatusEmitted schema.
export type DiscoveryState =
  | { status: 'idle' }
  | { status: 'detecting' }
  | { status: 'found'; preview: TerminalConfigImportPreview; fields: string[] }
  | { status: 'imported'; fields: string[] }
  | { status: 'absent' }
type _DiscoveryStatusEmittedSync =
  Exclude<DiscoveryState['status'], 'idle' | 'detecting'> extends DiscoveryStatusEmitted
    ? DiscoveryStatusEmitted extends Exclude<DiscoveryState['status'], 'idle' | 'detecting'>
      ? true
      : never
    : never
const _discoveryStatusEmittedSyncCheck: _DiscoveryStatusEmittedSync = true
void _discoveryStatusEmittedSyncCheck

function fieldGroupCountBucket(count: number): '0' | '1-3' | '4-7' | '8+' {
  if (count <= 0) {
    return '0'
  }
  if (count <= 3) {
    return '1-3'
  }
  if (count <= 7) {
    return '4-7'
  }
  return '8+'
}

export function ThemeStep({
  theme,
  onThemeChange,
  settings,
  updateSettings,
  lookBaseline,
  onLookBaselineChange
}: ThemeStepProps) {
  const t = useTranslate()
  const [importing, setImporting] = useState(false)
  const [discovery, setDiscovery] = useState<DiscoveryState>({ status: 'idle' })
  const mountedRef = useMountedRef()

  // Preview on mount for discovery; apply settings only after explicit Import.
  useEffect(() => {
    // Import is macOS-only; skip other platforms’ IPC/telemetry so absence rates reflect eligible hosts.
    if (!navigator.userAgent.includes('Mac')) {
      return
    }
    let cancelled = false
    setDiscovery({ status: 'detecting' })
    void window.api.settings
      .previewGhosttyImport()
      .then((preview) => {
        if (cancelled) {
          return
        }
        // Empty diffs can mean matching settings or unsupported keys; hide without claiming which.
        if (!preview.found || Object.keys(preview.diff).length === 0) {
          setDiscovery({ status: 'absent' })
          track('onboarding_ghostty_discovered', {
            state: 'absent',
            field_group_count_bucket: '0'
          })
          return
        }
        const fields = humanFields(preview.diff)
        setDiscovery({ status: 'found', preview, fields })
        track('onboarding_ghostty_discovered', {
          state: 'found',
          field_group_count_bucket: fieldGroupCountBucket(fields.length)
        })
      })
      .catch(() => {
        if (cancelled) {
          return
        }
        setDiscovery({ status: 'absent' })
        track('onboarding_ghostty_discovered', {
          state: 'absent',
          field_group_count_bucket: '0'
        })
      })
    return () => {
      cancelled = true
    }
  }, [])

  const importGhostty = async (preview: TerminalConfigImportPreview) => {
    if (!settings || importing) {
      return
    }
    // Track after the busy guard so ignored double-clicks cannot inflate import attempts.
    track('onboarding_ghostty_import_clicked', {})
    setImporting(true)
    try {
      const resolved = preview.found ? preview : await window.api.settings.previewGhosttyImport()
      if (!resolved.found || Object.keys(resolved.diff).length === 0) {
        if (mountedRef.current) {
          toast.info(
            t(
              'auto.components.onboarding.ThemeStep.16a9f0446a',
              'No Ghostty settings found to import'
            )
          )
        }
        track('onboarding_ghostty_import_failed', { reason: 'empty_diff' })
        return
      }
      const imported = terminalConfigImportSettingsUpdate(
        settings,
        resolved,
        getSystemPrefersDark()
      )
      await updateSettings(imported)
      // Why: later look picks start from the imported terminal, not the one it replaced.
      if (mountedRef.current) {
        onLookBaselineChange({ ...(lookBaseline ?? settings), ...imported })
      }
      // Sync the controller’s local theme so Continue cannot overwrite the imported theme.
      if (resolved.diff.theme && mountedRef.current) {
        onThemeChange(resolved.diff.theme)
      }
      const importedFields = humanFields(resolved.diff)
      if (mountedRef.current) {
        setDiscovery({ status: 'imported', fields: importedFields })
      }
      track('onboarding_ghostty_discovered', {
        state: 'imported',
        field_group_count_bucket: fieldGroupCountBucket(importedFields.length)
      })
    } catch (err) {
      if (mountedRef.current) {
        toast.error(
          t('auto.components.onboarding.ThemeStep.699ddf83c2', 'Failed to import Ghostty settings'),
          {
            description: err instanceof Error ? err.message : String(err)
          }
        )
      }
      track('onboarding_ghostty_import_failed', { reason: 'unknown' })
    } finally {
      if (mountedRef.current) {
        setImporting(false)
      }
    }
  }

  const systemPrefersDark = useSystemPrefersDark()
  const osBase: ThemeLookBase = systemPrefersDark ? 'dark' : 'light'
  const [systemSlot, setSystemSlot] = useState<ThemeLookBase | null>(null)
  const { looks, selected, pluginTerminalThemes } = useThemeLooks(settings, lookBaseline)
  // Why a slot picker under System: both looks persist, and only the OS chooses which one shows.
  const base: ThemeLookBase = theme === 'system' ? (systemSlot ?? osBase) : theme

  const pickLook = (look: ThemeLook): void => {
    if (settings && lookBaseline) {
      void updateSettings(
        themeLookSettingsUpdate(look, settings, lookBaseline, pluginTerminalThemes)
      )
    }
  }

  return (
    <div className="space-y-5">
      <section className="space-y-2.5">
        <ThemeSectionHeading
          title={t('components.onboarding.theme.looks.colorMode', 'Color mode')}
          caption={t(
            'components.onboarding.theme.looks.colorModeCaption',
            'Light, dark, or follow your OS.'
          )}
        />
        <ThemeModeTiles
          value={theme}
          onChange={(id) => {
            setSystemSlot(null)
            applyOnboardingThemeSelection(id, onThemeChange, updateSettings)
          }}
        />
      </section>

      <ThemeLookCarousel
        looks={looks[base]}
        selectedId={selected[base]}
        onPick={pickLook}
        ariaLabel={
          base === 'dark'
            ? t('components.onboarding.theme.looks.darkLooks', 'Dark looks')
            : t('components.onboarding.theme.looks.lightLooks', 'Light looks')
        }
        header={
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <ThemeSectionHeading
              title={t('components.onboarding.theme.looks.themes', 'Theme')}
              caption={
                theme === 'system' && base !== osBase
                  ? base === 'dark'
                    ? t(
                        'components.onboarding.theme.looks.showsWhenDark',
                        'Shows when your system is dark'
                      )
                    : t(
                        'components.onboarding.theme.looks.showsWhenLight',
                        'Shows when your system is light'
                      )
                  : t(
                      'components.onboarding.theme.looks.themesCaption',
                      'Optional. Go further with app themes and terminal palettes.'
                    )
              }
            />
            {theme === 'system' && (
              <div className="w-60 shrink-0">
                <ThemeSlotControl value={base} osBase={osBase} onChange={setSystemSlot} />
              </div>
            )}
          </div>
        }
      />

      <GhosttyDiscoveryRow
        discovery={discovery}
        importing={importing}
        disabled={!settings}
        onImport={importGhostty}
      />

      <div className="space-y-1.5 px-1 text-[12px] text-muted-foreground">
        <div className="flex items-center gap-2">
          <Puzzle className="size-3.5" />
          <span>
            {t(
              'components.onboarding.theme.looks.pluginsHint',
              'More themes are available as plugins.'
            )}
          </span>
          <button
            type="button"
            className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
            onClick={openThemePluginDirectory}
          >
            {t('components.onboarding.theme.looks.browseThemePlugins', 'Browse theme plugins')}
            <ExternalLink className="size-3" />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <Settings2 className="size-3.5" />
          <span>
            <Trans
              i18n={i18n}
              defaults={t(
                'auto.components.onboarding.ThemeStep.moreTerminalOptions',
                'More terminal options, including font, cursor, and palette, in <settings>Settings → Terminal</settings>'
              )}
              components={{ settings: <span className="font-medium text-foreground" /> }}
            />
          </span>
        </div>
      </div>
    </div>
  )
}

function humanFields(diff: Partial<GlobalSettings>): string[] {
  // Group related fields into summary chips; unlabeled diff keys still import.
  const groups: { label: string; keys: (keyof GlobalSettings)[] }[] = [
    {
      label: translate('auto.components.onboarding.ThemeStep.cc1858e19e', 'Font'),
      keys: ['terminalFontFamily', 'terminalFontSize', 'terminalFontWeight']
    },
    {
      label: translate('auto.components.onboarding.ThemeStep.ab2a583a97', 'Cursor'),
      keys: ['terminalCursorStyle', 'terminalCursorBlink', 'terminalCursorOpacity']
    },
    {
      label: translate('auto.components.onboarding.ThemeStep.c021e9dddd', 'Theme palette'),
      keys: ['terminalThemeDark', 'terminalThemeLight']
    },
    {
      label: translate('auto.components.onboarding.ThemeStep.06a24f4f2d', 'Colors'),
      keys: ['terminalColorOverrides', 'terminalColorOverridesLight']
    },
    {
      label: translate('auto.components.onboarding.ThemeStep.86c0f1caa2', 'Padding'),
      keys: ['terminalPaddingX', 'terminalPaddingY']
    },
    {
      label: translate('auto.components.onboarding.ThemeStep.b3a99a2d29', 'Window'),
      keys: ['terminalBackgroundOpacity', 'windowMaterial', 'terminalInactivePaneOpacity']
    },
    {
      label: translate('auto.components.onboarding.ThemeStep.8ca01945f2', 'Dividers'),
      keys: ['terminalDividerColorDark', 'terminalDividerColorLight']
    },
    {
      label: translate('auto.components.onboarding.ThemeStep.6c51398942', 'Mouse'),
      keys: ['terminalMouseHideWhileTyping', 'terminalFocusFollowsMouse']
    },
    {
      label: translate('auto.components.onboarding.ThemeStep.a4b254779d', 'macOS Option key'),
      keys: ['terminalMacOptionAsAlt']
    }
  ]
  return groups.filter(({ keys }) => keys.some((k) => k in diff)).map(({ label }) => label)
}

function ThemeSectionHeading({
  title,
  caption
}: {
  title: string
  caption: string
}): React.JSX.Element {
  return (
    <h3 className="text-sm font-medium text-foreground">
      {title}
      <span className="ml-2 text-xs font-normal text-muted-foreground">{caption}</span>
    </h3>
  )
}
