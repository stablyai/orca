import type { ReactNode } from 'react'
import { StepBadge, type StepState } from './SetupStepBadge'
import { cn } from '@/lib/utils'

type TaskSourceStepRowProps = {
  index: number
  state: StepState
  title: string
  description: string
  action?: ReactNode
  children?: ReactNode
  className?: string
}

export function TaskSourceStepRow({
  index,
  state,
  title,
  description,
  action,
  children,
  className
}: TaskSourceStepRowProps): React.JSX.Element {
  return (
    <li className={cn('py-3', className)}>
      <div className="flex items-start gap-3">
        <StepBadge index={index} state={state} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium text-foreground">{title}</p>
              <p className="text-xs text-muted-foreground">{description}</p>
            </div>
            {action ? <div className="shrink-0">{action}</div> : null}
          </div>
          {children}
        </div>
      </div>
    </li>
  )
}
