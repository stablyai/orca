import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { buildAgentStatusHookAffectedRows } from './agent-status-hook-disclosure-rows'

export function AgentStatusHooksControl({
  enabled,
  onEnabledChange,
  detectedAgentIds,
  disabledTuiAgents
}: {
  enabled: boolean
  onEnabledChange?: (enabled: boolean) => void
  detectedAgentIds: Iterable<TuiAgent>
  disabledTuiAgents?: unknown
}): React.JSX.Element {
  const label = translate(
    'auto.components.onboarding.AgentStatusHooksControl.label',
    'Enable agent status hooks'
  )
  const affected = buildAgentStatusHookAffectedRows({ detectedAgentIds, disabledTuiAgents })

  return (
    <div className="flex shrink-0 flex-col gap-2">
      <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-border bg-muted/25 px-4 py-3 transition-colors hover:bg-muted/40">
        <span className="flex min-w-0 items-center gap-3">
          <Checkbox
            checked={enabled}
            onCheckedChange={(checked) => onEnabledChange?.(checked === true)}
            className="border-border bg-card data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground"
            aria-label={label}
          />
          <span className="min-w-0 text-sm font-medium text-foreground">{label}</span>
        </span>
      </label>
      <p className="px-1 text-xs text-muted-foreground">
        {translate(
          'auto.components.onboarding.AgentStatusHooksControl.why',
          "Enables Orca to track your CLI agents' statuses, so it can inform you when each is working, needs you, or is done. Also powers your notifications."
        )}
      </p>
      {/* Sibling of the label, never nested inside it: a trigger under the label would toggle the checkbox. */}
      <Collapsible defaultOpen={false}>
        <CollapsibleTrigger className="cursor-pointer px-1 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:mb-2">
          {translate(
            'auto.components.onboarding.AgentStatusHooksControl.disclosureSummary',
            'What Orca changes, and when'
          )}
        </CollapsibleTrigger>
        <CollapsibleContent className="collapsible-height-content">
          {/* Capped height so a long detected-agent list cannot crush the flex-1 agent grid above. */}
          <div className="scrollbar-sleek flex max-h-40 flex-col gap-2 overflow-y-auto px-1 pr-2">
            <DisclosureRow
              label={translate(
                'auto.components.onboarding.AgentStatusHooksControl.whenLabel',
                'When'
              )}
            >
              {translate(
                'auto.components.onboarding.AgentStatusHooksControl.whenBody',
                "When you continue from this step, for the agent CLIs found on your machine. Orca keeps them current on later launches. Agents you don't have are skipped, and nothing is written for them."
              )}
            </DisclosureRow>
            <DisclosureRow
              label={translate(
                'auto.components.onboarding.AgentStatusHooksControl.affectedLabel',
                'Affected'
              )}
            >
              {affected.length > 0 && (
                <ul className="mb-1 space-y-0.5">
                  {affected.map((row) => (
                    <li key={row.agent} className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-foreground">{row.name}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {row.location}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {translate(
                'auto.components.onboarding.AgentStatusHooksControl.affectedScriptNote',
                "Plus a small script in ~/.orca/agent-hooks/. Status is reported to Orca on your machine, it isn't uploaded anywhere."
              )}
            </DisclosureRow>
            <DisclosureRow
              label={translate(
                'auto.components.onboarding.AgentStatusHooksControl.yourHooksLabel',
                'Your hooks'
              )}
            >
              {translate(
                'auto.components.onboarding.AgentStatusHooksControl.yourHooksBody',
                "Orca only adds or removes entries that point at its own script, hooks you wrote are left alone. These live in your agent's own config, so they run in every session, not just ones started from Orca. When Orca isn't running the hook exits immediately and can never block or deny a tool call."
              )}
            </DisclosureRow>
            <DisclosureRow
              label={translate(
                'auto.components.onboarding.AgentStatusHooksControl.turningOffLabel',
                'Turning off'
              )}
            >
              {translate(
                'auto.components.onboarding.AgentStatusHooksControl.turningOffBody',
                'Removes the entries Orca added and stops it reinstalling them on the next launch.'
              )}
            </DisclosureRow>
          </div>
        </CollapsibleContent>
      </Collapsible>
      <p className="px-1 text-xs text-muted-foreground">
        {translate(
          'auto.components.onboarding.AgentStatusHooksControl.offRamp',
          'Turn this off any time in Settings → Agents.'
        )}
      </p>
      {!enabled && (
        <p className="px-1 text-xs text-amber-700 dark:text-amber-200/90">
          {translate(
            'auto.components.onboarding.AgentStatusHooksControl.uncheckedConsequence',
            'Orca will fall back to reading terminal output. Resumed sessions show no status until you type, finished turns can stay stuck on "working", and Cursor reports nothing at all.'
          )}
        </p>
      )}
    </div>
  )
}

function DisclosureRow({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] gap-x-3 text-xs leading-relaxed">
      <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
        {label}
      </span>
      <div className="min-w-0 text-muted-foreground">{children}</div>
    </div>
  )
}
