import type React from 'react'
import { cn } from '@/lib/utils'
import { StepBadge, type StepState } from './SetupStepBadge'

export function SetupStepCard({
  index,
  state,
  title,
  tag,
  why,
  headerAction,
  children
}: {
  index: number
  state: StepState
  title: string
  tag: string
  why: string
  headerAction?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'rounded-xl border border-border/60 bg-card/50 p-4',
        state === 'in-progress' && 'border-border'
      )}
    >
      <div className="flex items-start gap-3">
        <StepBadge index={index} state={state} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{title}</span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {tag}
              </span>
            </div>
            {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{why}</p>
          <div className="mt-3">{children}</div>
        </div>
      </div>
    </div>
  )
}
