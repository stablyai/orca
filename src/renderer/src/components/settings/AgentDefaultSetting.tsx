import { Check, Terminal } from 'lucide-react'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import { AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { SettingsSubsectionHeader } from './SettingsFormControls'

function DefaultAgentPill({
  active,
  onClick,
  children,
  title
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  title?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={cn(
        'inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
        active
          ? 'border-muted-foreground/40 bg-accent font-medium text-accent-foreground'
          : 'border-border bg-background/50 text-muted-foreground hover:border-muted-foreground/35 hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}

export function AgentDefaultSetting({
  defaultAgent,
  detectedIds,
  enabledDetectedAgents,
  catalog,
  description,
  onSetDefault
}: {
  defaultAgent: TuiAgent | 'blank' | null
  detectedIds: Set<string> | null
  enabledDetectedAgents: AgentCatalogEntry[]
  catalog: AgentCatalogEntry[]
  description: string
  onSetDefault: (agent: TuiAgent | 'blank' | null) => void
}): React.JSX.Element {
  const storedDefaultAgent =
    defaultAgent !== null && defaultAgent !== 'blank'
      ? catalog.find((agent) => agent.id === defaultAgent)
      : undefined
  const defaultAgentPills =
    storedDefaultAgent && !enabledDetectedAgents.some((agent) => agent.id === storedDefaultAgent.id)
      ? [...enabledDetectedAgents, storedDefaultAgent]
      : enabledDetectedAgents

  return (
    <section className="space-y-4">
      <SettingsSubsectionHeader
        title={translate('auto.components.settings.AgentsPane.385212c7a1', 'Default Agent')}
        description={description}
      />
      <div className="flex flex-wrap gap-2">
        <DefaultAgentPill active={defaultAgent === null} onClick={() => onSetDefault(null)}>
          {defaultAgent === null && <Check className="size-3.5" />}
          {translate('auto.components.settings.AgentsPane.92033495ff', 'Auto')}
        </DefaultAgentPill>
        <DefaultAgentPill active={defaultAgent === 'blank'} onClick={() => onSetDefault('blank')}>
          <Terminal className="size-3.5" />
          {translate('auto.components.settings.AgentsPane.110b74b022', 'No agent (blank terminal)')}
          {defaultAgent === 'blank' && <Check className="size-3.5" />}
        </DefaultAgentPill>
        {defaultAgentPills.map((agent) => {
          const isActive = defaultAgent === agent.id
          const isUndetected = detectedIds !== null && !detectedIds.has(agent.id)
          return (
            <DefaultAgentPill
              key={agent.id}
              active={isActive}
              onClick={() => onSetDefault(agent.id)}
              title={
                isUndetected
                  ? translate(
                      'auto.components.settings.AgentsPane.storedDefaultUndetected',
                      'Saved as your default, but not detected right now'
                    )
                  : undefined
              }
            >
              <AgentIcon agent={agent.id} size={14} />
              {agent.label}
              {isActive && <Check className="size-3.5" />}
            </DefaultAgentPill>
          )
        })}
      </div>
    </section>
  )
}
