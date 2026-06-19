import { LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

export type IntegrationCardStatusTone = 'connected' | 'attention' | 'neutral'

const STATUS_TONE_CLASSES: Record<IntegrationCardStatusTone, string> = {
  connected: 'border-status-success-border bg-status-success-background text-status-success',
  attention: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  neutral: 'border-border bg-background text-muted-foreground'
}

export function IntegrationCardShell(props: {
  icon: React.ReactNode
  name: string
  description: React.ReactNode
  statusLabel: string
  statusTone: IntegrationCardStatusTone
  checking?: boolean
  className?: string
  actions?: React.ReactNode
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'rounded-xl border border-border/60 bg-card/40 px-4 py-3.5 shadow-xs',
        props.className
      )}
    >
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-muted-foreground">{props.icon}</span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm font-medium">{props.name}</p>
          <p className="text-xs text-muted-foreground">{props.description}</p>
        </div>
        {props.actions ? (
          <div className="flex shrink-0 items-center gap-1.5">{props.actions}</div>
        ) : null}
        {props.checking ? (
          <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <span
            className={cn(
              'shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium',
              STATUS_TONE_CLASSES[props.statusTone]
            )}
          >
            {props.statusLabel}
          </span>
        )}
      </div>
      {props.children}
    </div>
  )
}

export function IntegrationCardDetails(props: {
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={cn('mt-3 space-y-2 border-t border-border/40 pt-3', props.className)}>
      {props.children}
    </div>
  )
}
