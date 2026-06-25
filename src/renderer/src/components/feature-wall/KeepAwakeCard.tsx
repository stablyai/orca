import type { JSX } from 'react'
import { cn } from '@/lib/utils'
import { getAgentAwakeDescription, getAgentAwakeTitle } from '../settings/agent-awake-copy'
import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

export function KeepAwakeCard(props: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): JSX.Element {
  const { settings, updateSettings } = props
  const enabled = settings.keepComputerAwakeWhileAgentsRun
  const title = getAgentAwakeTitle()
  return (
    <div className="rounded-xl border border-border bg-muted/20 p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 shrink space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-[15px] font-semibold leading-tight text-foreground">{title}</div>
            <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {translate('auto.components.feature.wall.KeepAwakeCard.209713d3c7', 'Optional')}
            </span>
          </div>
          <p className="text-[13px] leading-snug text-muted-foreground">
            {getAgentAwakeDescription()}
          </p>
        </div>
        <button
          role="switch"
          aria-label={title}
          aria-checked={enabled}
          onClick={() => updateSettings({ keepComputerAwakeWhileAgentsRun: !enabled })}
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
