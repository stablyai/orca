import type { JSX } from 'react'
import { cn } from '@/lib/utils'
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
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={translate(
            'auto.components.contextual.tours.ContextualTourControl.186eecc34f',
            'Auto-name workspace from first agent message'
          )}
          onClick={() => {
            toggleAutoRenameBranchFromWork({
              enabled,
              updateSettings,
              dispatchEvent: (event) => window.dispatchEvent(event)
            })
          }}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors',
            enabled ? 'bg-foreground' : 'bg-muted-foreground/30'
          )}
        >
          <span
            className={cn(
              'pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform',
              enabled ? 'translate-x-4' : 'translate-x-0.5'
            )}
          />
        </button>
      </div>
    </div>
  )
}
