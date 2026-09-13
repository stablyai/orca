import { useMemo, useState } from 'react'
import { Link2 } from 'lucide-react'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { AgentIcon, getAgentCatalog } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { translate } from '@/i18n/i18n'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { TabAgentLaunchOption } from '../tab-bar/tab-agent-launch-options'

export function AgentCanvasAgentMenu({
  agents,
  options,
  disabled,
  onLaunch,
  onAttach
}: {
  agents: DashboardCard[]
  options: TabAgentLaunchOption[]
  disabled: boolean
  onLaunch: (agent: TuiAgent) => void
  onAttach: (card: DashboardCard) => void
}) {
  const [open, setOpen] = useState(false)
  const catalog = useMemo(
    () =>
      options.flatMap((option) => {
        const entry = getAgentCatalog().find((agent) => agent.id === option.agent)
        return entry ? [entry] : []
      }),
    [options]
  )
  return (
    <>
      <fieldset
        disabled={disabled}
        className="w-64 max-w-full min-w-0 border-0 p-0 disabled:opacity-50"
      >
        <AgentCombobox
          agents={catalog}
          value={null}
          allowBlankTerminal={false}
          allowNarrowTrigger
          emptyLabel={translate('agentCanvas.newAgent', 'New agent')}
          triggerAriaLabel={translate('agentCanvas.newAgent', 'New agent')}
          triggerClassName="h-6 w-full"
          onValueChange={(agent) => {
            if (agent && !disabled) {
              onLaunch(agent)
            }
          }}
          onOpenManageAgents={() => {
            const store = useAppStore.getState()
            store.openSettingsTarget({ pane: 'agents', repoId: null })
            store.openSettingsPage()
          }}
        />
      </fieldset>
      {agents.length > 0 && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="xs" disabled={disabled}>
              <Link2 />
              {translate('agentCanvas.attachRunning', 'Attach a workspace session')}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 p-0">
            <Command>
              <CommandInput placeholder={translate('agentCanvas.searchAgents', 'Search agents…')} />
              <CommandList>
                <CommandEmpty>
                  {translate('agentCanvas.noSessionMatch', 'No matching sessions.')}
                </CommandEmpty>
                <CommandGroup
                  heading={translate('agentCanvas.attachRunning', 'Attach a workspace session')}
                >
                  {agents.map((card) => (
                    <CommandItem
                      key={card.paneKey}
                      value={`${card.paneKey} ${card.conversationName ?? card.agentType}`}
                      onSelect={() => {
                        setOpen(false)
                        onAttach(card)
                      }}
                    >
                      <AgentIcon
                        agent={getAgentCatalog().find((entry) => entry.id === card.agentType)?.id}
                        size={14}
                      />
                      {card.conversationName ?? card.agentType}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      )}
    </>
  )
}
