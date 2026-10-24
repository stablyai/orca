import type React from 'react'

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
