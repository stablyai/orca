import { Check, Loader2 } from 'lucide-react'

export type StepState = 'pending' | 'done' | 'in-progress'

export function StepBadge({
  index,
  state
}: {
  index: number
  state: StepState
}): React.JSX.Element {
  if (state === 'done') {
    return (
      <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
        <Check className="size-3.5" />
      </div>
    )
  }
  if (state === 'in-progress') {
    return (
      <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
      </div>
    )
  }
  return (
    <div className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border/70 text-xs font-medium text-muted-foreground">
      {index}
    </div>
  )
}
