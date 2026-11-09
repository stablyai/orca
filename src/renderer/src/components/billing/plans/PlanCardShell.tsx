import { Check } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * Shared plan card layout. Both cards use the same rows (title, price, details, features,
 * footer) and stretch to the same height, so their dividers and buttons line up.
 */
export function PlanCardShell({
  id,
  title,
  badge,
  price,
  priceNote,
  details,
  featuresLead,
  features,
  footer
}: {
  id: string
  title: ReactNode
  badge?: ReactNode
  price: ReactNode
  priceNote: ReactNode
  details?: ReactNode
  featuresLead?: string
  features: string[]
  footer: ReactNode
}): React.JSX.Element {
  return (
    <section
      aria-labelledby={id}
      className="flex h-full flex-col gap-5 rounded-xl border border-border bg-card p-5 shadow-xs"
    >
      <div className="flex min-h-6 items-center justify-between gap-3">
        <h3 id={id} className="flex items-center gap-2 text-base font-semibold">
          {title}
        </h3>
        {badge}
      </div>
      <div className="space-y-1">
        {price}
        <p className="text-xs text-muted-foreground">{priceNote}</p>
      </div>
      {details}
      <div className="flex-1 space-y-2.5">
        {featuresLead ? (
          <p className="text-xs font-medium text-muted-foreground">{featuresLead}</p>
        ) : null}
        <ul className="space-y-2.5">
          {features.map((feature) => (
            <li key={feature} className="flex items-start gap-2 text-sm text-pretty">
              <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>{feature}</span>
            </li>
          ))}
        </ul>
      </div>
      {/* Fixed footer height (button + up to two lines) keeps both cards' dividers level. */}
      <div className="flex min-h-[6rem] flex-col justify-start gap-2 border-t border-border/60 pt-4">
        {footer}
      </div>
    </section>
  )
}
