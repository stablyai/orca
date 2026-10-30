import type { JSX } from 'react'
import {
  BookmarkPlus,
  Camera,
  Code2,
  Highlighter,
  KeyRound,
  Languages,
  Pipette,
  Puzzle,
  ShieldCheck
} from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { useAppStore } from '@/store'
import type { ContextualTourStepControl } from '../../../../shared/contextual-tours'
import { CONTEXTUAL_TOUR_ENABLE_AUTO_WORKSPACE_NAME_EVENT } from './contextual-tour-composer-events'
import { translate } from '@/i18n/i18n'

export function ContextualTourControl({
  control
}: {
  control: ContextualTourStepControl
}): JSX.Element | null {
  switch (control.kind) {
    case 'auto-rename-branch-from-work':
      return <AutoRenameBranchFromWorkControl />
    case 'browser-extension-pin-preview':
      return <BrowserExtensionPinPreview />
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
  const enabled = useAppStore((s) => s.settings?.autoRenameBranchFromWork === true)
  const updateSettings = useAppStore((s) => s.updateSettings)

  return (
    <div className="mt-3 rounded-md border border-border/70 bg-muted/35 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium text-foreground">
            {translate(
              'auto.components.contextual.tours.ContextualTourControl.731c5573df',
              'Auto-name from first message'
            )}
          </div>
        </div>
        <Switch
          checked={enabled}
          aria-label={translate(
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

const PIN_PREVIEW_ICONS = [
  KeyRound,
  ShieldCheck,
  Code2,
  Languages,
  Pipette,
  Highlighter,
  Camera,
  BookmarkPlus
] as const

/** Decorative toolbar strip: pinned extensions land left of the puzzle menu. */
function BrowserExtensionPinPreview(): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="mt-3 flex justify-center rounded-md border border-border/70 bg-muted/35 px-3 py-3"
    >
      <div className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2 shadow-xs">
        {PIN_PREVIEW_ICONS.map((Icon, index) => (
          <span
            key={index}
            className="flex size-5 items-center justify-center rounded-[5px] bg-muted text-foreground motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-50 motion-safe:duration-300"
            style={{
              animationDelay: `${200 + index * 70}ms`,
              animationFillMode: 'both'
            }}
          >
            <Icon className="size-3" />
          </span>
        ))}
        <span className="mx-0.5 h-4 w-px bg-border" />
        <Puzzle className="size-3.5 text-muted-foreground" />
      </div>
    </div>
  )
}
