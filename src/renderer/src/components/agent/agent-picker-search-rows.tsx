import type { ReactNode, Ref } from 'react'
import { Check } from 'lucide-react'
import { AgentVariantIcon } from '@/components/agent/icons/AgentVariantIcon'
import { CommandItem } from '@/components/ui/command'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { AgentDefaultContextMenu } from './agent-combobox-items'
import type { AgentPickerSetup } from '../../../../shared/agent-launch/picker/agent-launch-picker-search'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'

/** A choice that is not an agent, such as "Blank Terminal" or "Use default agent". */
export type AgentPickerChoice = {
  id: string
  label: string
  icon?: ReactNode
  /** Whether a search lists it; by default its label holds every typed word. */
  matches?: (query: string) => boolean
  isDefault?: boolean
  onSetDefault?: () => void
  onSelect: () => void
}

export type AgentLaunchSetupSearch = {
  entries: readonly AgentPickerEntry[]
  /** The agent and model the form holds now, checked among the results. */
  current?: { agent: AgentPickerEntry['agent']; model?: string }
  onPick: (setup: AgentPickerSetup) => void
  /** An agent named by the search, picked as it is. */
  onPickAgent: (entry: AgentPickerEntry) => void
  /** Rows under the card, which a search also lists. */
  choices?: readonly AgentPickerChoice[]
}

export const choiceMatches = (choice: AgentPickerChoice, query: string) => {
  if (choice.matches) {
    return choice.matches(query)
  }
  const label = choice.label.toLowerCase()
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .every((word) => label.includes(word))
}

export const setupRowKey = (setup: AgentPickerSetup) =>
  `${setup.entry.agent}\u0000${setup.model.id}\u0000${setup.choices.options?.effort ?? ''}`

/** A search over every agent: named agents, then models and levels, then matching choices. */
export function AgentPickerSearchResults({
  agents,
  results,
  choices,
  current,
  disabled,
  onPick,
  onPickAgent
}: {
  agents: readonly AgentPickerEntry[]
  results: readonly AgentPickerSetup[]
  choices: readonly AgentPickerChoice[]
  current?: AgentLaunchSetupSearch['current']
  disabled?: boolean
  onPick: (setup: AgentPickerSetup) => void
  onPickAgent: (entry: AgentPickerEntry) => void
}) {
  return (
    <>
      {agents.map((candidate) => (
        <CommandItem
          key={`agent\u0000${candidate.agent}`}
          value={`agent\u0000${candidate.agent}`}
          selection="palette"
          disabled={disabled}
          onSelect={() => onPickAgent(candidate)}
        >
          <AgentVariantIcon agent={candidate.agent} size={14} />
          <span className="min-w-0 flex-1 truncate">{candidate.label}</span>
        </CommandItem>
      ))}
      {results.map((setup) => {
        const checked =
          setup.entry.agent === current?.agent &&
          setup.model.id === current.model &&
          !setup.choices.options?.effort
        const effort = setup.model.efforts.find(
          (choice) => choice.value === setup.choices.options?.effort
        )
        return (
          <CommandItem
            key={setupRowKey(setup)}
            value={setupRowKey(setup)}
            selection="palette"
            disabled={disabled}
            data-current={checked}
            onSelect={() => onPick(setup)}
          >
            <AgentVariantIcon agent={setup.entry.agent} size={14} />
            <span className="min-w-0 flex-1 truncate">
              {[setup.model.label, effort?.label].filter(Boolean).join(' · ')}
            </span>
            <span className="flex size-3.5 shrink-0 items-center justify-center">
              {checked ? <Check className="size-3.5 text-muted-foreground" /> : null}
            </span>
          </CommandItem>
        )
      })}
      {choices.map((choice) => (
        <CommandItem
          key={`choice\u0000${choice.id}`}
          value={`choice\u0000${choice.id}`}
          selection="palette"
          disabled={disabled}
          onSelect={choice.onSelect}
        >
          {choice.icon}
          <span className="min-w-0 flex-1 truncate">{choice.label}</span>
        </CommandItem>
      ))}
    </>
  )
}

/** The full-width rows under the card; ArrowUp from the first goes back to the search. */
export function AgentPickerChoiceRows({
  ref,
  choices,
  disabled,
  onLeaveUp
}: {
  ref: Ref<HTMLDivElement>
  choices: readonly AgentPickerChoice[]
  disabled?: boolean
  onLeaveUp: () => void
}) {
  return (
    <div
      ref={ref}
      className="border-t border-border p-1"
      onKeyDown={(event) => {
        const first = event.currentTarget.querySelector('[role="menuitem"]')
        if (event.key === 'ArrowUp' && event.target === first) {
          event.preventDefault()
          onLeaveUp()
        }
      }}
    >
      {choices.map((choice) => (
        <AgentDefaultContextMenu
          key={choice.id}
          isDefault={choice.isDefault ?? false}
          onSetDefault={choice.onSetDefault}
        >
          <DropdownMenuItem disabled={disabled} onSelect={choice.onSelect}>
            {choice.icon}
            {choice.label}
          </DropdownMenuItem>
        </AgentDefaultContextMenu>
      ))}
    </div>
  )
}
