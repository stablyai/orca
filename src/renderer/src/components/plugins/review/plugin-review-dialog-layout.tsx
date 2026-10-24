import type React from 'react'

/** Scrolling middle row of a review dialog whose DialogContent uses
 *  `grid-rows-[auto_minmax(0,1fr)_auto]`, so header and footer stay in view. */
export function PluginReviewBody({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="-mx-6 min-h-0 overflow-y-auto px-6 scrollbar-sleek">
      <div className="divide-y divide-border/60">{children}</div>
    </div>
  )
}

export function PluginReviewSection({
  title,
  headingId,
  children
}: {
  title?: string
  headingId?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="space-y-2 py-4 first:pt-0 last:pb-0" aria-labelledby={headingId}>
      {title ? (
        <h3
          id={headingId}
          className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground"
        >
          {title}
        </h3>
      ) : null}
      {children}
    </section>
  )
}
