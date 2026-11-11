import type React from 'react'

type AgentAccountsSubsectionProps = {
  id: string
  title: React.ReactNode
  description?: React.ReactNode
  children: React.ReactNode
}

/** One part of Settings → Agent accounts (this computer, other hosts, …). Builds can add their own
 *  parts through renderAccountsSettingsSection's `additionalSections`. */
export function AgentAccountsSubsection({
  id,
  title,
  description,
  children
}: AgentAccountsSubsectionProps): React.JSX.Element {
  const titleId = `${id}-title`
  return (
    <section id={id} aria-labelledby={titleId} className="scroll-mt-8 space-y-5">
      <div className="space-y-1 border-b border-border/60 pb-3">
        <h3 id={titleId} className="text-lg font-semibold leading-tight text-foreground">
          {title}
        </h3>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  )
}
