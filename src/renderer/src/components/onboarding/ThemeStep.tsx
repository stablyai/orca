import { useEffect, useState } from 'react'
import { Settings2 } from 'lucide-react'
import { Trans } from 'react-i18next'
import { toast } from 'sonner'
import { track } from '@/lib/telemetry'
import { useMountedRef } from '@/hooks/useMountedRef'
import { GhosttyDiscoveryRow } from './GhosttyDiscoveryRow'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { DiscoveryStatusEmitted } from '../../../../shared/onboarding-state-types'
import { i18n, translate } from '@/i18n/i18n'
import {
  ThemeLookList,
  ThemeModeControl,
  ThemeSlotControl,
  useThemeLooks
} from './ThemeLookGallery'
import { ThemeLookHero } from './ThemeLookPreview'
import type { ThemeLook, ThemeLookBase } from './onboarding-theme-looks'
import { themeLookSettingsUpdate } from './onboarding-theme-look-settings'
import {
  terminalConfigImportSettingsUpdate,
  type TerminalConfigImportPreview
} from '../../../../shared/terminal/appearance/terminal-config-import-preview'
import { getSystemPrefersDark } from '@/lib/terminal-theme'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'

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
            translate(
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
        onLookBaselineChange({ ...settings, ...imported })
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
          translate(
            'auto.components.onboarding.ThemeStep.699ddf83c2',
            'Failed to import Ghostty settings'
          ),
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
  const [previewLook, setPreviewLook] = useState<ThemeLook | null>(null)
  const { looks, selected, pluginTerminalThemes } = useThemeLooks(settings, lookBaseline)
  // Why a slot picker under System: both looks persist, and only the OS chooses which one shows.
  const base: ThemeLookBase = theme === 'system' ? (systemSlot ?? osBase) : theme
  const selectedLook = looks[base].find((look) => look.id === selected[base]) ?? null
  const shownLook = previewLook?.base === base ? previewLook : selectedLook

  const pickLook = (look: ThemeLook): void => {
    if (settings && lookBaseline) {
      void updateSettings(
        themeLookSettingsUpdate(look, settings, lookBaseline, pluginTerminalThemes)
      )
    }
  }

  const groups = [
    {
      id: 'app',
      title: translate('components.onboarding.theme.looks.appThemes', 'App themes'),
      looks: looks[base].filter((look) => look.kind !== 'terminal')
    },
    {
      id: 'terminal',
      title: translate('components.onboarding.theme.looks.terminalPalettes', 'Terminal palettes'),
      caption: translate(
        'components.onboarding.theme.looks.terminalPalettesCaption',
        'Orca recolors itself to match'
      ),
      looks: looks[base].filter((look) => look.kind === 'terminal')
    }
  ]
  const heroLabels = {
    workspaces: translate('components.onboarding.theme.looks.previewWorkspaces', 'Workspaces'),
    agentPrompt: translate(
      'components.onboarding.theme.looks.previewPrompt',
      'restyle the settings page'
    ),
    agentRead: translate('components.onboarding.theme.looks.previewRead', 'Read'),
    agentEdited: translate('components.onboarding.theme.looks.previewEdited', 'Edited 3 files'),
    agentDone: translate('components.onboarding.theme.looks.previewDone', 'Done in'),
    statusMode: translate('components.onboarding.theme.looks.previewStatus', 'accept edits on')
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <ThemeModeControl
          value={theme}
          onChange={(id) => {
            setSystemSlot(null)
            applyOnboardingThemeSelection(id, onThemeChange, updateSettings)
          }}
        />
        <p className="px-0.5 text-xs text-muted-foreground">
          {theme === 'system'
            ? translate(
                'components.onboarding.theme.looks.systemCaption',
                'Orca follows your OS, switching between a dark and a light look.'
              )
            : translate(
                'components.onboarding.theme.looks.appliesTo',
                'Each look colors the app, editor, and terminal together.'
              )}
        </p>
      </div>

      <GhosttyDiscoveryRow
        discovery={discovery}
        importing={importing}
        disabled={!settings}
        onImport={importGhostty}
      />

      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_17rem]">
        <figure className="min-w-0 space-y-2.5">
          <div className="aspect-[16/10] max-h-[min(340px,32vh)] w-full overflow-hidden rounded-xl border border-border shadow-xs">
            {shownLook && <ThemeLookHero palette={shownLook.palette} labels={heroLabels} />}
          </div>
          <figcaption className="flex min-h-5 items-baseline gap-2 px-0.5">
            <span className="truncate text-sm font-medium text-foreground">{shownLook?.label}</span>
            <span className="truncate text-2xs text-muted-foreground">{shownLook?.source}</span>
            {theme === 'system' && base !== osBase && (
              <span className="ml-auto shrink-0 text-2xs text-muted-foreground">
                {base === 'dark'
                  ? translate(
                      'components.onboarding.theme.looks.showsWhenDark',
                      'Shows when your system is dark'
                    )
                  : translate(
                      'components.onboarding.theme.looks.showsWhenLight',
                      'Shows when your system is light'
                    )}
              </span>
            )}
          </figcaption>
        </figure>

        <div className="min-w-0 space-y-3">
          {theme === 'system' && (
            <ThemeSlotControl value={base} osBase={osBase} onChange={setSystemSlot} />
          )}
          <div className="scrollbar-sleek -mx-1 px-1 md:max-h-[min(340px,32vh)] md:overflow-y-auto">
            <ThemeLookList
              groups={groups}
              selectedId={selected[base]}
              onPick={pickLook}
              onPreview={setPreviewLook}
              ariaLabel={
                base === 'dark'
                  ? translate('components.onboarding.theme.looks.darkLooks', 'Dark looks')
                  : translate('components.onboarding.theme.looks.lightLooks', 'Light looks')
              }
            />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 px-1 text-[12px] text-muted-foreground">
        <Settings2 className="size-3.5" />
        <span>
          <Trans
            i18n={i18n}
            defaults={translate(
              'auto.components.onboarding.ThemeStep.moreTerminalOptions',
              'More terminal options, including font, cursor, and palette, in <settings>Settings → Terminal</settings>'
            )}
            components={{ settings: <span className="font-medium text-foreground" /> }}
          />
        </span>
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
