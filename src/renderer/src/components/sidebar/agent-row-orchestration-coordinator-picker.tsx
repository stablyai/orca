import React from 'react'
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

export function AgentRowOrchestrationCoordinatorPicker({
  options,
  value,
  disabled = false,
  onChange
}: Props) {
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
        aria-labelledby="orchestration-action-coordinator-label"
        className="border-input max-h-40 space-y-1 overflow-y-auto rounded-md border p-1"
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
                type="button"
                role="option"
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
