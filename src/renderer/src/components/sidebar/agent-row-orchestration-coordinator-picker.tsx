import { useCallback } from 'react'
import { Label } from '@/components/ui/label'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent } from '@/lib/agent-status'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { CoordinatorCandidate } from './agent-row-orchestration-coordinator'

type Props = {
  options: CoordinatorCandidate[]
  value: string
  disabled?: boolean
  onChange: (paneKey: string) => void
}

function optionDomId(paneKey: string): string {
  // Why: paneKeys contain ':' which is awkward in HTML ids / CSS selectors.
  return `orchestration-coordinator-option-${paneKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

export function AgentRowOrchestrationCoordinatorPicker({
  options,
  value,
  disabled = false,
  onChange
}: Props) {
  // Why: role=listbox expects arrow-key movement between options, not only Tab.
  const onListboxKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled || options.length === 0) {
        return
      }
      if (
        event.key !== 'ArrowDown' &&
        event.key !== 'ArrowUp' &&
        event.key !== 'Home' &&
        event.key !== 'End'
      ) {
        return
      }
      event.preventDefault()
      const currentIndex = Math.max(
        0,
        options.findIndex((option) => option.paneKey === value)
      )
      let nextIndex = currentIndex
      if (event.key === 'ArrowDown') {
        nextIndex = Math.min(options.length - 1, currentIndex + 1)
      } else if (event.key === 'ArrowUp') {
        nextIndex = Math.max(0, currentIndex - 1)
      } else if (event.key === 'Home') {
        nextIndex = 0
      } else if (event.key === 'End') {
        nextIndex = options.length - 1
      }
      const next = options[nextIndex]
      if (!next) {
        return
      }
      onChange(next.paneKey)
      document.getElementById(optionDomId(next.paneKey))?.focus()
    },
    [disabled, onChange, options, value]
  )

  return (
    <div className="space-y-2">
      <Label id="orchestration-action-coordinator-label">
        {translate(
          'auto.components.sidebar.agent.row.orchestration.action.dialog.coordinator',
          'Coordinator (who owns this)'
        )}
      </Label>
      <div
        role="listbox"
        tabIndex={disabled || options.length === 0 ? -1 : 0}
        aria-labelledby="orchestration-action-coordinator-label"
        aria-activedescendant={value ? optionDomId(value) : undefined}
        onKeyDown={onListboxKeyDown}
        className="border-input scrollbar-sleek max-h-40 space-y-1 overflow-y-auto rounded-md border p-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {options.length === 0 ? (
          <p className="text-muted-foreground px-2 py-1.5 text-sm">
            {translate(
              'auto.components.sidebar.agent.row.orchestration.action.dialog.coordinator.empty',
              'No other terminal in this worktree'
            )}
          </p>
        ) : (
          options.map((option) => {
            const selected = option.paneKey === value
            return (
              <button
                key={option.paneKey}
                id={optionDomId(option.paneKey)}
                type="button"
                role="option"
                tabIndex={selected ? 0 : -1}
                aria-selected={selected}
                disabled={disabled}
                onClick={() => onChange(option.paneKey)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
                  'hover:bg-accent hover:text-accent-foreground',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  selected && 'bg-accent text-accent-foreground',
                  disabled && 'opacity-50'
                )}
              >
                <span className="inline-flex shrink-0" title={option.agentType ?? 'agent'}>
                  <AgentIcon agent={agentTypeToIconAgent(option.agentType)} size={14} />
                </span>
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
              </button>
            )
          })
        )}
      </div>
      <p className="text-muted-foreground text-[11px] leading-snug">
        {translate(
          'auto.components.sidebar.agent.row.orchestration.action.dialog.coordinator.hint',
          'Worker = the agent you right-clicked. Coordinator = who dispatches and receives worker_done.'
        )}
      </p>
    </div>
  )
}
