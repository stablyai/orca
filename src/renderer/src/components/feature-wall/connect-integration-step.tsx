import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { IntegrationStepState } from './use-integration-connection-status'
import { translate } from '@/i18n/i18n'

export type { IntegrationStepState }

// One progressive step. The active step shows its instructional copy and
// provider rows; a done step collapses to a one-line summary with a "Change"
// affordance that reopens it inline; upcoming steps stay quiet and inert until
// the prior step completes. `expanded` (body visibility) is tracked separately
// from `state` so a done step can reopen while still reading as connected.
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
  const canToggle = done && (props.canToggle ?? true)

  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border bg-card transition-colors',
        active || (done && expanded) ? 'border-foreground/25 shadow-xs' : 'border-border',
        state === 'upcoming' && 'opacity-55'
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
              ? 'border-status-success-border bg-status-success-background text-status-success'
              : active
                ? 'border-foreground bg-foreground text-background'
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
            {expanded
              ? translate(
                  'auto.components.feature.wall.connect.integration.step.5538eb6743',
                  'Done'
                )
              : translate(
                  'auto.components.feature.wall.connect.integration.step.0f47ff17c6',
                  'Change'
                )}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div className="space-y-2 border-t border-border bg-muted/30 p-3">{props.children}</div>
      ) : null}
    </div>
  )
}

// Two progress dots tracking step state; the active one stretches into a bar.
export function IntegrationProgress(props: {
  states: readonly IntegrationStepState[]
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5 pt-2" aria-hidden>
      {props.states.map((state, i) => (
        <span
          key={i}
          className={cn(
            'h-[7px] rounded-full transition-all',
            state === 'active' ? 'w-[22px] bg-foreground' : 'w-[7px]',
            state === 'done' ? 'bg-status-success' : state !== 'active' && 'bg-border'
          )}
        />
      ))}
    </div>
  )
}

// Acknowledges the step-1 code host as an already-usable task source so we
// don't ask the user to connect the same gh/glab auth twice. "Use … issues"
// resolves the step without a tracker; the copy never claims a tracker exists.
export function CodeHostTaskNote(props: {
  providerName: string
  onAccept?: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2.5 border-t border-border px-1 pb-1 pt-3 text-[13px] leading-snug text-muted-foreground">
      <Check className="mt-px size-3.5 shrink-0 text-status-success" />
      <div className="min-w-0 flex-1">
        <span>
          <span className="font-semibold text-foreground">{props.providerName}</span>{' '}
          {translate(
            'auto.components.feature.wall.connect.integration.step.8de7b6848c',
            'issues are already available as a task source.'
          )}
        </span>
        <span className="mt-0.5 block text-[12px]">
          {translate(
            'auto.components.feature.wall.connect.integration.step.05334a6812',
            'Connect a tracker above only if your team plans work there.'
          )}
        </span>
        {props.onAccept ? (
          <Button
            variant="ghost"
            size="xs"
            className="mt-1.5 h-auto px-0 text-[12px] text-foreground hover:bg-transparent hover:underline"
            onClick={props.onAccept}
          >
            {translate(
              'auto.components.feature.wall.connect.integration.step.use_provider_issues',
              'Use {{value0}} issues for tasks',
              { value0: props.providerName }
            )}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
