// A16 "Agent accounts & secrets" (spec v4 §4): a right-side sheet, the same frame for every host kind.
// Section 1 is the agents, then either the Cloud sections (W6) or keys + one environment line.
import React from 'react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import type { CloudDotState } from '@/lib/orca-cloud/orca-cloud-workspace-state'
import { CloudStateDot } from '../orca-cloud/CloudStateDot'
import { PanelSection } from './cloud-sections/PanelSection'
import type { AgentHostCapabilities, AgentHostFooterLink } from './agent-host-capabilities'

function footerLabel(link: AgentHostFooterLink, t: Translate): string {
  switch (link) {
    case 'accounts':
      return t('agentHostPanel.footer.accounts', 'Accounts')
    case 'agentAccounts':
      return t('agentHostPanel.footer.agentAccounts', 'Agent accounts')
    case 'agentApiKeys':
      return t('agentHostPanel.footer.agentApiKeys', 'Agent API keys')
    case 'cloudSecrets':
      return t('agentHostPanel.footer.cloudSecrets', 'Cloud secrets')
    case 'customEnvironments':
      return t('agentHostPanel.footer.customEnvironments', 'Custom environments')
    case 'allHosts':
      return t('agentHostPanel.footer.allHosts', 'All hosts')
  }
}

export type AgentHostPanelViewProps = {
  capabilities: AgentHostCapabilities
  /** The first part of the subline: the host name, or the Cloud workspace. */
  subject: string | null
  /** Cloud and recipe sublines start with the state dot. */
  dot?: CloudDotState | null
  /** Section 1's body (the agents section renders its own frame). */
  agents: React.ReactNode
  /** Orca Cloud: sections 2–3 from Cloud secrets (W6). */
  cloudSections?: React.ReactNode
  /** Other kinds: section 2's rows. */
  keys?: React.ReactNode
  /** Section 3's body where it isn't one line (recipe VM warning). */
  environment?: React.ReactNode
  onFooterLink: (link: AgentHostFooterLink) => void
}

/** The sheet's contents; the caller owns the Sheet (open state) so fixtures can render it open. */
export function AgentHostPanelView({
  capabilities,
  subject,
  dot,
  agents,
  cloudSections,
  keys,
  environment,
  onFooterLink
}: AgentHostPanelViewProps): React.JSX.Element {
  const t = useTranslate()
  const titleId = React.useId()
  const headerId = React.useId()
  const subline = [subject, capabilities.kindLabel, capabilities.stateLabel]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
  return (
    <SheetContent
      side="right"
      className="w-[460px] sm:max-w-[460px]"
      // Start on the labelled title, never on a control (a disabled one would pop its tooltip).
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        document.getElementById(headerId)?.focus()
      }}
    >
      {/* The labelled header takes first focus; it has no ring because no control is focused. */}
      <div
        id={headerId}
        tabIndex={-1}
        role="group"
        aria-labelledby={titleId}
        className="border-b border-border pe-8 outline-none"
      >
        <SheetHeader>
          <SheetTitle id={titleId}>
            {t('agentHostPanel.title', 'Agent accounts & secrets')}
          </SheetTitle>
          <SheetDescription>
            <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-xs">
              {dot ? <CloudStateDot state={dot} size="md" /> : null}
              <span className="truncate">{subline}</span>
            </span>
          </SheetDescription>
        </SheetHeader>
      </div>
      <div className="scrollbar-sleek flex min-h-0 flex-1 flex-col divide-y divide-border overflow-y-auto">
        {capabilities.notice ? (
          <p
            role="status"
            className="mx-5 mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-5 text-muted-foreground"
          >
            {capabilities.notice}
          </p>
        ) : null}
        {agents}
        {capabilities.cloudSecrets ? (
          cloudSections
        ) : (
          <>
            <PanelSection title={capabilities.keys.title} help={capabilities.keys.help}>
              {keys}
            </PanelSection>
            <PanelSection
              title={t('agentHostPanel.section.env', 'Environment')}
              help={capabilities.environmentHelp ?? undefined}
            >
              {environment}
            </PanelSection>
          </>
        )}
      </div>
      <nav
        aria-label={t('agentHostPanel.footer.label', 'Related settings')}
        className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-5 py-3 text-xs"
      >
        {capabilities.footer.map((link) => (
          <button
            key={link}
            type="button"
            className="text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-[var(--focus-ring)]"
            onClick={() => onFooterLink(link)}
          >
            {footerLabel(link, t)}
          </button>
        ))}
      </nav>
    </SheetContent>
  )
}
