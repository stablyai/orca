import { useEffect, useState } from 'react'
import { Check, Monitor, Moon, Settings2, Sun } from 'lucide-react'
import { Trans } from 'react-i18next'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { track } from '@/lib/telemetry'
import { useMountedRef } from '@/hooks/useMountedRef'
import { GhosttyDiscoveryRow } from './GhosttyDiscoveryRow'
import type { GhosttyImportPreview, GlobalSettings } from '../../../../shared/global-settings-types'
import type { DiscoveryStatusEmitted } from '../../../../shared/onboarding-state-types'
import { i18n, translate } from '@/i18n/i18n'
import { ChromePreview } from './theme-chrome-preview'

type ThemeStepProps = {
  theme: GlobalSettings['theme']
  onThemeChange: (theme: GlobalSettings['theme']) => void
  settings: GlobalSettings | null
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
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
  | { status: 'found'; preview: GhosttyImportPreview; fields: string[] }
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

export function ThemeStep({ theme, onThemeChange, settings, updateSettings }: ThemeStepProps) {
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

  const importGhostty = async (preview: GhosttyImportPreview) => {
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
      await updateSettings({
        ...resolved.diff,
        ...(resolved.diff.terminalColorOverrides
          ? {
              terminalColorOverrides: {
                ...settings.terminalColorOverrides,
                ...resolved.diff.terminalColorOverrides
              }
            }
          : {})
      })
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

  const themes: {
    id: GlobalSettings['theme']
    label: string
    hint: string
    icon: typeof Monitor
  }[] = [
    {
      id: 'system',
      label: translate('auto.components.onboarding.ThemeStep.827ea7b4a2', 'System'),
      hint: translate('components.onboarding.theme.hints.system', 'Match OS'),
      icon: Monitor
    },
    {
      id: 'dark',
      label: translate('auto.components.onboarding.ThemeStep.fa7b673ea9', 'Dark'),
      hint: translate('components.onboarding.theme.hints.dark', 'Easy on the eyes'),
      icon: Moon
    },
    {
      id: 'light',
      label: translate('auto.components.onboarding.ThemeStep.ad192706e6', 'Light'),
      hint: translate('components.onboarding.theme.hints.light', 'Bright & crisp'),
      icon: Sun
    }
  ]

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        {themes.map(({ id, label, hint, icon: Icon }) => {
          const selected = theme === id
          return (
            <button
              key={id}
              className={cn(
                'group overflow-hidden rounded-xl border p-3 text-left transition-colors',
                selected ? 'border-foreground/60 bg-accent' : 'border-border hover:bg-accent/60'
              )}
              onClick={() => applyOnboardingThemeSelection(id, onThemeChange, updateSettings)}
            >
              <div className="relative mb-3 h-24 overflow-hidden rounded-lg border border-border">
                <ChromePreview variant={id} />
                {selected && (
                  <div className="absolute right-1.5 top-1.5 grid size-5 place-items-center rounded-full bg-foreground text-background shadow-sm">
                    <Check className="size-3" strokeWidth={3} />
                  </div>
                )}
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <Icon className="size-3.5 text-muted-foreground" />
                  {label}
                </div>
                <div className="text-[11px] text-muted-foreground">{hint}</div>
              </div>
            </button>
          )
        })}
      </div>

      <GhosttyDiscoveryRow
        discovery={discovery}
        importing={importing}
        disabled={!settings}
        onImport={importGhostty}
      />

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
      keys: ['terminalColorOverrides']
    },
    {
      label: translate('auto.components.onboarding.ThemeStep.86c0f1caa2', 'Padding'),
      keys: ['terminalPaddingX', 'terminalPaddingY']
    },
    {
      label: translate('auto.components.onboarding.ThemeStep.b3a99a2d29', 'Window'),
      keys: ['terminalBackgroundOpacity', 'windowBackgroundBlur', 'terminalInactivePaneOpacity']
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
