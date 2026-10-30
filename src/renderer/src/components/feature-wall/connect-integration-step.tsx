import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { IntegrationStepState } from './use-integration-connection-status'
import { translate } from '@/i18n/i18n'

export type { IntegrationStepState }

// Track expansion separately from connection state so completed steps can reopen without losing their status.
export function IntegrationStep(props: {
  index: number
  state: IntegrationStepState
  expanded: boolean
  title: string
  description: string
  summary?: React.ReactNode
  onToggle?: () => void
  canToggle?: boolean
  children?: React.ReactNode
}): React.JSX.Element {
  const { state, expanded, onToggle } = props
  const done = state === 'done'
  const active = state === 'active'
  // Allow tracker-first setup; step order is a recommendation, not a prerequisite.
  const canToggle = !active && (props.canToggle ?? true)

  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border bg-card transition-colors',
        active || (done && expanded) ? 'border-foreground/25 shadow-xs' : 'border-border'
      )}
    >
      <button
        type="button"
        onClick={canToggle ? onToggle : undefined}
        disabled={!canToggle}
        aria-current={active ? 'step' : undefined}
        aria-expanded={canToggle ? expanded : undefined}
        className={cn(
          'flex w-full items-center gap-3 px-4 py-3.5 text-left',
          canToggle ? 'hover:bg-accent/50' : 'cursor-default'
        )}
      >
        <span
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-full border text-[13px] font-semibold leading-none',
            done
              ? 'border-foreground bg-foreground text-background'
              : active
                ? 'border-foreground text-foreground'
                : 'border-border text-muted-foreground'
          )}
        >
          {done ? <Check className="size-3.5" /> : props.index + 1}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-semibold leading-tight text-foreground">
            {props.title}
          </span>
          <span className="mt-0.5 block text-[13px] leading-snug text-muted-foreground">
            {done ? props.summary : props.description}
          </span>
        </span>
        {canToggle ? (
          <span className="shrink-0 text-[12px] font-medium text-muted-foreground">
            {done
              ? expanded
                ? translate(
                    'auto.components.feature.wall.connect.integration.step.5538eb6743',
                    'Done'
                  )
                : translate(
                    'auto.components.feature.wall.connect.integration.step.0f47ff17c6',
                    'Change'
                  )
              : expanded
                ? translate(
                    'auto.components.feature.wall.connect.integration.step.close_step',
                    'Close'
                  )
                : translate(
                    'auto.components.feature.wall.connect.integration.step.open_step',
                    'Open'
                  )}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div className="space-y-2 border-t border-border bg-card p-3">{props.children}</div>
      ) : null}
    </div>
  )
}
