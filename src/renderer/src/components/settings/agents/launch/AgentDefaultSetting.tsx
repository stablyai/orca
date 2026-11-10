import { Check } from 'lucide-react'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'

import type { AgentCatalogEntry } from '@/lib/agent-catalog/agent-catalog'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { SettingsGroup } from '../../section-layout/SettingsGroup'

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
  onSetDefault,
  defaultOpensAsChat = false,
  permissions
}: {
  defaultAgent: TuiAgent | 'blank' | null
  detectedIds: Set<string> | null
  /** The saved default opens as a chat on this host without its CLI. */
  defaultOpensAsChat?: boolean
  enabledDetectedAgents: AgentCatalogEntry[]
  catalog: AgentCatalogEntry[]
  description: string
  onSetDefault: (agent: TuiAgent | 'blank' | null) => void
  permissions: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const storedDefaultAgent =
    defaultAgent !== null && defaultAgent !== 'blank'
      ? catalog.find((agent) => agent.id === defaultAgent)
      : undefined
  const defaultAgentPills =
    storedDefaultAgent && !enabledDetectedAgents.some((agent) => agent.id === storedDefaultAgent.id)
      ? [...enabledDetectedAgents, storedDefaultAgent]
      : enabledDetectedAgents

  return (
    <SettingsGroup
      title={t('auto.components.settings.AgentsPane.3bddd54c9e', 'Default agent')}
      description={description}
    >
      <div className="flex flex-wrap gap-2 py-4">
        <DefaultAgentPill
          active={defaultAgent === null}
          onClick={() => onSetDefault(defaultAgent === null ? 'blank' : null)}
        >
          {defaultAgent === null && <Check className="size-3.5" />}
          {t('auto.components.settings.AgentsPane.92033495ff', 'Auto')}
        </DefaultAgentPill>
        {defaultAgentPills.map((agent) => {
          const isActive = defaultAgent === agent.id
          const isUndetected =
            detectedIds !== null && !detectedIds.has(agent.id) && !(isActive && defaultOpensAsChat)
          return (
            <DefaultAgentPill
              key={agent.id}
              active={isActive}
              onClick={() => onSetDefault(isActive ? 'blank' : agent.id)}
              title={
                isUndetected
                  ? t(
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
      <div data-settings-row="" className="py-3">
        {permissions}
      </div>
    </SettingsGroup>
  )
}
