import { useEffect, useState } from 'react'
import { Check, Monitor, Moon, Settings2, Sun } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { track } from '@/lib/telemetry'
import type {
  DiscoveryStatusEmitted,
  GhosttyImportPreview,
  GlobalSettings
} from '../../../../shared/types'
import ghosttyIcon from '../../../../../resources/ghostty.svg'

type ThemeStepProps = {
  theme: GlobalSettings['theme']
  onThemeChange: (theme: GlobalSettings['theme']) => void
  settings: GlobalSettings | null
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
}

// The two UI-only states (`'idle'`, `'detecting'`) never fire telemetry. The
// remaining states are exactly `DiscoveryStatusEmitted`, which is the
// schema-side enum the compile-time guard in
// `src/shared/telemetry-events.ts` locks against.
type DiscoveryState =
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

  // Why: read-only IPC. Auto-detect on step mount so the user sees a clear
  // "we found your Ghostty config" prompt instead of a buried Import button.
  // Settings are not applied until the user clicks Import (per design doc).
  useEffect(() => {
    // Why: Ghostty config-import is darwin-only (see src/main/ghostty/discovery.ts).
    // Skip the IPC + telemetry emission entirely on non-Mac so the
    // `_discovered: absent` rate measured by the Mac-cohort dashboard isn't
    // polluted by a population that cannot have a Ghostty config.
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
        // Why: hide the row when there's nothing to import. An empty diff can
        // mean "settings already match" *or* "every key in the config was
        // unsupported by the mapper" (e.g. theme = some-named-theme); we can't
        // tell, so don't make a claim either way.
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
    // Why: track AFTER the busy guard so a double-click during an in-flight
    // import doesn't inflate the click counter when no second import attempt
    // actually proceeds.
    track('onboarding_ghostty_import_clicked', {})
    setImporting(true)
    try {
      const resolved = preview.found ? preview : await window.api.settings.previewGhosttyImport()
      if (!resolved.found || Object.keys(resolved.diff).length === 0) {
        toast.info('No Ghostty settings found to import')
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
      // Why: parent controller holds local `theme` state that overwrites
      // settings.theme on Continue; sync it so the import isn't clobbered.
      if (resolved.diff.theme) {
        onThemeChange(resolved.diff.theme)
      }
      const importedFields = humanFields(resolved.diff)
      setDiscovery({ status: 'imported', fields: importedFields })
      track('onboarding_ghostty_discovered', {
        state: 'imported',
        field_group_count_bucket: fieldGroupCountBucket(importedFields.length)
      })
    } catch (err) {
      toast.error('Failed to import Ghostty settings', {
        description: err instanceof Error ? err.message : String(err)
      })
      track('onboarding_ghostty_import_failed', { reason: 'unknown' })
    } finally {
      setImporting(false)
    }
  }

  const themes: {
    id: GlobalSettings['theme']
    label: string
    hint: string
    icon: typeof Monitor
  }[] = [
    { id: 'system', label: 'System', hint: 'Match OS', icon: Monitor },
    { id: 'dark', label: 'Dark', hint: 'Easy on the eyes', icon: Moon },
    { id: 'light', label: 'Light', hint: 'Bright & crisp', icon: Sun }
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
                'group overflow-hidden rounded-xl border p-3 text-left transition-all',
                selected
                  ? 'border-violet-500/60 bg-violet-500/10 ring-2 ring-violet-500/30'
                  : 'border-border bg-muted/30 hover:bg-muted/60'
              )}
              onClick={() => onThemeChange(id)}
            >
              <div className="relative mb-3 h-24 overflow-hidden rounded-lg border border-border">
                <ChromePreview variant={id} />
                {selected && (
                  <div className="absolute right-1.5 top-1.5 grid size-5 place-items-center rounded-full bg-violet-500 text-white shadow-sm">
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
          More terminal options, including font, cursor, and palette, in{' '}
          <span className="font-medium text-foreground">Settings → Terminal</span>
        </span>
      </div>
    </div>
  )
}

function GhosttyDiscoveryRow({
  discovery,
  importing,
  disabled,
  onImport
}: {
  discovery: DiscoveryState
  importing: boolean
  disabled: boolean
  onImport: (preview: GhosttyImportPreview) => void
}) {
  // Why: 'idle' is the pre-effect state that persists on non-Mac (the
  // discovery effect short-circuits there), so render nothing instead of
  // showing the dashed-border "Looking for a Ghostty config…" placeholder.
  if (discovery.status === 'absent' || discovery.status === 'idle') {
    return null
  }

  if (discovery.status === 'detecting') {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-dashed border-border bg-transparent px-3.5 py-2.5 text-[12px] text-muted-foreground">
        <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground/60" />
        Looking for a Ghostty config…
      </div>
    )
  }

  if (discovery.status === 'imported') {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/[0.07] px-3.5 py-2.5 text-[12px] text-foreground">
        <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" strokeWidth={3} />
        <span className="flex-1">
          <span className="font-medium">Imported from Ghostty.</span>
          {discovery.fields.length > 0 && (
            <span className="text-muted-foreground"> {discovery.fields.join(' · ')}</span>
          )}
        </span>
      </div>
    )
  }

  const { preview, fields } = discovery
  return (
    <div className="flex items-center gap-3 rounded-lg border border-violet-500/30 bg-violet-500/[0.06] px-3.5 py-2.5">
      <img src={ghosttyIcon} alt="" className="size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-[12px] text-foreground">
          <span className="font-medium">Ghostty config detected.</span>{' '}
          <span className="text-muted-foreground">
            Import {fields.length > 0 ? fields.map((f) => f.toLowerCase()).join(', ') : 'settings'}?
          </span>
        </div>
        {preview.configPath && (
          <div
            className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground"
            title={preview.configPath}
          >
            {preview.configPath}
          </div>
        )}
      </div>
      <button
        className="shrink-0 rounded-md bg-foreground px-3 py-1.5 text-[11.5px] font-semibold text-background hover:bg-foreground/90 disabled:opacity-50"
        disabled={importing || disabled}
        onClick={() => onImport(preview)}
      >
        {importing ? 'Importing…' : 'Import'}
      </button>
    </div>
  )
}

function ChromePreview({ variant }: { variant: GlobalSettings['theme'] }) {
  if (variant === 'system') {
    return (
      <div className="relative size-full">
        <div
          className="absolute inset-0"
          style={{ clipPath: 'polygon(0 0, 50% 0, 50% 100%, 0 100%)' }}
        >
          <ChromeMock dark />
        </div>
        <div
          className="absolute inset-0"
          style={{ clipPath: 'polygon(50% 0, 100% 0, 100% 100%, 50% 100%)' }}
        >
          <ChromeMock dark={false} />
        </div>
        <div
          aria-hidden
          className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/70"
        />
      </div>
    )
  }
  return <ChromeMock dark={variant === 'dark'} />
}

function ChromeMock({ dark }: { dark: boolean }) {
  // Tiny Orca chrome: sidebar with two rows + a content area with a tab and
  // a composer line. Pure Tailwind so it stays lightweight inside the tile.
  const bg = dark ? 'bg-[#0f1115]' : 'bg-[#f7f8fa]'
  const sidebar = dark ? 'bg-[#16181d]' : 'bg-[#eceef2]'
  const sidebarBorder = dark ? 'border-white/5' : 'border-black/5'
  const row = dark ? 'bg-white/10' : 'bg-black/10'
  const rowDim = dark ? 'bg-white/5' : 'bg-black/5'
  const tab = dark ? 'bg-[#1d2026] border-white/5' : 'bg-white border-black/5'
  const accent = 'bg-violet-500/80'
  return (
    <div className={cn('flex size-full', bg)}>
      <div className={cn('flex w-[34%] flex-col gap-1 border-r p-1.5', sidebar, sidebarBorder)}>
        <div className={cn('h-1 w-7 rounded-sm', rowDim)} />
        <div className="mt-0.5 flex items-center gap-1">
          <span className={cn('size-1 rounded-full', accent)} />
          <span className={cn('h-1 flex-1 rounded-sm', row)} />
        </div>
        <div className="flex items-center gap-1">
          <span className={cn('size-1 rounded-full', rowDim)} />
          <span className={cn('h-1 flex-1 rounded-sm', rowDim)} />
        </div>
        <div className="flex items-center gap-1">
          <span className={cn('size-1 rounded-full', rowDim)} />
          <span className={cn('h-1 w-3/4 rounded-sm', rowDim)} />
        </div>
      </div>
      <div className="flex flex-1 flex-col p-1.5">
        <div className="flex gap-1">
          <div className={cn('h-2 w-8 rounded-sm border', tab)} />
          <div className={cn('h-2 w-5 rounded-sm', rowDim)} />
        </div>
        <div className="mt-1.5 flex-1 space-y-1">
          <div className={cn('h-1 w-full rounded-sm', rowDim)} />
          <div className={cn('h-1 w-5/6 rounded-sm', rowDim)} />
          <div className={cn('h-1 w-2/3 rounded-sm', rowDim)} />
        </div>
        <div className={cn('mt-1 flex h-2.5 items-center gap-1 rounded-sm border px-1', tab)}>
          <span className={cn('size-1 rounded-full', accent)} />
          <span className={cn('h-0.5 flex-1 rounded-sm', rowDim)} />
        </div>
      </div>
    </div>
  )
}

function humanFields(diff: Partial<GlobalSettings>): string[] {
  // Why: chip labels are a friendly summary, not a strict 1:1 of mapper keys.
  // Group related diff keys (font weight + family + size → "Font") so the row
  // stays tidy. Anything in the diff that doesn't match a label still gets
  // imported; it just isn't surfaced as a chip.
  const groups: { label: string; keys: (keyof GlobalSettings)[] }[] = [
    { label: 'Font', keys: ['terminalFontFamily', 'terminalFontSize', 'terminalFontWeight'] },
    {
      label: 'Cursor',
      keys: ['terminalCursorStyle', 'terminalCursorBlink', 'terminalCursorOpacity']
    },
    { label: 'Theme palette', keys: ['terminalThemeDark', 'terminalThemeLight'] },
    { label: 'Colors', keys: ['terminalColorOverrides'] },
    { label: 'Padding', keys: ['terminalPaddingX', 'terminalPaddingY'] },
    {
      label: 'Window',
      keys: ['terminalBackgroundOpacity', 'windowBackgroundBlur', 'terminalInactivePaneOpacity']
    },
    {
      label: 'Dividers',
      keys: ['terminalDividerColorDark', 'terminalDividerColorLight']
    },
    { label: 'Mouse', keys: ['terminalMouseHideWhileTyping', 'terminalFocusFollowsMouse'] },
    { label: 'macOS Option key', keys: ['terminalMacOptionAsAlt'] }
  ]
  return groups.filter(({ keys }) => keys.some((k) => k in diff)).map(({ label }) => label)
}
