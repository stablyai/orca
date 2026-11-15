import type { JSX } from 'react'
import { Code2, Highlighter, KeyRound, Languages, Pipette, Puzzle, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { Switch } from '@/components/ui/switch'
import { useAppStore } from '@/store'
import type { ContextualTourStepControl } from '../../../../shared/contextual-tours'
import { CONTEXTUAL_TOUR_ENABLE_AUTO_WORKSPACE_NAME_EVENT } from './contextual-tour-composer-events'
import { useTranslate } from '@/i18n/use-translate'

export function ContextualTourControl({
  control
}: {
  control: ContextualTourStepControl
}): JSX.Element | null {
  switch (control.kind) {
    case 'auto-rename-branch-from-work':
      return <AutoRenameBranchFromWorkControl />
    case 'browser-extension-icons':
      return <BrowserExtensionIcons colored={control.colored} />
  }
}

export function toggleAutoRenameBranchFromWork(args: {
  enabled: boolean
  updateSettings: (settings: { autoRenameBranchFromWork: boolean }) => void | Promise<unknown>
  dispatchEvent: (event: Event) => void
}): void {
  const nextEnabled = !args.enabled
  void args.updateSettings({ autoRenameBranchFromWork: nextEnabled })
  if (nextEnabled) {
    args.dispatchEvent(new Event(CONTEXTUAL_TOUR_ENABLE_AUTO_WORKSPACE_NAME_EVENT))
  }
}

function AutoRenameBranchFromWorkControl(): JSX.Element {
  const t = useTranslate()
  const enabled = useAppStore((s) => s.settings?.autoRenameBranchFromWork === true)
  const updateSettings = useAppStore((s) => s.updateSettings)

  return (
    <div className="mt-3 rounded-md border border-border/70 bg-muted/35 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium text-foreground">
            {t(
              'auto.components.contextual.tours.ContextualTourControl.731c5573df',
              'Auto-name from first message'
            )}
          </div>
        </div>
        <Switch
          checked={enabled}
          aria-label={t(
            'auto.components.contextual.tours.ContextualTourControl.186eecc34f',
            'Auto-name workspace from first agent message'
          )}
          onCheckedChange={() => {
            toggleAutoRenameBranchFromWork({
              enabled,
              updateSettings,
              dispatchEvent: (event) => window.dispatchEvent(event)
            })
          }}
        />
      </div>
    </div>
  )
}

// Why fixed hues: the strip stands in for real extension icons, which are brand-colored.
const EXTENSION_ICON_TILES = [
  { Icon: KeyRound, tile: 'bg-sky-500' },
  { Icon: ShieldCheck, tile: 'bg-emerald-500' },
  { Icon: Code2, tile: 'bg-violet-500' },
  { Icon: Languages, tile: 'bg-blue-500' },
  { Icon: Pipette, tile: 'bg-pink-500' },
  { Icon: Highlighter, tile: 'bg-amber-500' }
] as const

/** Decorative toolbar strip: extensions pinned left of the puzzle menu. */
function BrowserExtensionIcons({ colored }: { colored: boolean }): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="mt-3 flex justify-center rounded-lg border border-border bg-muted/35 px-3 py-3.5"
    >
      <div className="flex h-9 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 shadow-xs">
        {EXTENSION_ICON_TILES.map(({ Icon, tile }, index) => (
          <span
            key={index}
            className={cn(
              'flex size-6 items-center justify-center rounded-md',
              colored ? `${tile} text-white` : 'bg-muted text-muted-foreground'
            )}
          >
            <Icon className="size-3.5" strokeWidth={2.25} />
          </span>
        ))}
        <span className="mx-0.5 h-5 w-px bg-border" />
        <Puzzle className="size-4 text-foreground" />
      </div>
    </div>
  )
}
