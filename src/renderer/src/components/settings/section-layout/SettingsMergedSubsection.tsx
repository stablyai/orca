import type React from 'react'
import { cn } from '@/lib/class-names'

type SettingsMergedSubsectionProps = {
  /** The former page's id: deep links to it scroll here. */
  id: string
  title: React.ReactNode
  description?: React.ReactNode
  /** Draw the body in the card a non-grouped SettingsSection uses. */
  card?: boolean
  children: React.ReactNode
}

/** A former Settings page shown as one part of a related page (e.g. Quick commands in Terminal). */
export function SettingsMergedSubsection({
  id,
  title,
  description,
  card = false,
  children
}: SettingsMergedSubsectionProps): React.JSX.Element {
  const titleId = `${id}-title`
  return (
    <section id={id} aria-labelledby={titleId} className="scroll-mt-8 space-y-4">
      <div className="space-y-1 border-b border-border/60 pb-3">
        <h3 id={titleId} className="text-lg font-semibold leading-tight text-foreground">
          {title}
        </h3>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      <div
        className={cn(card && 'rounded-xl border border-border/50 bg-card/50 px-7 py-6 shadow-xs')}
      >
        {children}
      </div>
    </section>
  )
}
