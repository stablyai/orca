import type React from 'react'

/** One part of Settings → Agent accounts beyond "This computer"; builds pass these to
 *  renderAccountsSettingsSection, which titles each one and lists it in the jump row. */
export type AgentAccountsPart = {
  id: string
  title: string
  description?: React.ReactNode
  content: React.ReactNode
}

export function agentAccountsSubsectionTitleId(id: string): string {
  return `${id}-title`
}

type AgentAccountsSubsectionProps = {
  id: string
  title: React.ReactNode
  description?: React.ReactNode
  children: React.ReactNode
}

/** One part of Settings → Agent accounts (this computer, other hosts, …). */
export function AgentAccountsSubsection({
  id,
  title,
  description,
  children
}: AgentAccountsSubsectionProps): React.JSX.Element {
  const titleId = agentAccountsSubsectionTitleId(id)
  return (
    <section id={id} aria-labelledby={titleId} className="scroll-mt-8 space-y-5">
      <div className="space-y-1 border-b border-border/60 pb-3">
        {/* tabIndex -1: the jump row moves focus here without adding a tab stop. */}
        <h3
          id={titleId}
          tabIndex={-1}
          className="text-lg font-semibold leading-tight text-foreground focus:outline-none"
        >
          {title}
        </h3>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  )
}
