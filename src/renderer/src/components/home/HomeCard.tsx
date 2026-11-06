import React from 'react'
import { cn } from '@/lib/utils'

/** Shared surface for Home sections so every card keeps the same header rhythm. */
export function HomeCard({
  title,
  count,
  action,
  className,
  children
}: {
  title: string
  count?: number
  action?: React.ReactNode
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section
      className={cn(
        'flex min-h-0 flex-col rounded-lg border border-border/60 bg-card/30 p-4',
        className
      )}
    >
      <header className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {count !== undefined ? (
          <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">
            {count}
          </span>
        ) : null}
        {action ? <div className="ml-auto flex items-center">{action}</div> : null}
      </header>
      {children}
    </section>
  )
}

export function HomeCardEmpty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="py-2 text-xs text-muted-foreground">{children}</p>
}
