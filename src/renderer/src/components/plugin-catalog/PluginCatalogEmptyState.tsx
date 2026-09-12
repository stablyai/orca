import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

type PluginCatalogEmptyStateProps = {
  icon: LucideIcon
  title: string
  description: string
  action?: React.ReactNode
  className?: string
  tone?: 'default' | 'destructive'
}

/** Centered empty / error surface used across the plugin catalog. */
export function PluginCatalogEmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  tone = 'default'
}: PluginCatalogEmptyStateProps): React.JSX.Element {
  const destructive = tone === 'destructive'
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-12 text-center',
        destructive ? 'border-destructive/30 bg-destructive/5' : 'border-border/80 bg-muted/20',
        className
      )}
    >
      <div
        className={cn(
          'mb-4 flex size-12 items-center justify-center rounded-2xl border shadow-xs',
          destructive
            ? 'border-destructive/25 bg-destructive/10 text-destructive'
            : 'border-border/70 bg-card text-muted-foreground'
        )}
      >
        <Icon className="size-5" aria-hidden="true" />
      </div>
      <h4
        className={cn(
          'text-sm font-semibold tracking-tight',
          destructive ? 'text-destructive' : 'text-foreground'
        )}
      >
        {title}
      </h4>
      <p
        className={cn(
          'mt-1.5 max-w-sm text-[13px] leading-5',
          destructive ? 'text-destructive/90' : 'text-muted-foreground'
        )}
      >
        {description}
      </p>
      {action ? (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}</div>
      ) : null}
    </div>
  )
}
