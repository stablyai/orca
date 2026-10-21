import React from 'react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  getMachineDisplayState,
  getMachineDisplayStateLabel
} from '@/lib/machines/machine-display-state'
import type { MachineMatch } from '@/lib/machines/machine-host-match'
import { describeMachine } from '@/lib/machines/machine-copy'
import { MachineStateDot } from './MachineStateLabel'

/**
 * The host chip for a worktree on a machine: its name and state dot, with provider, state and
 * lifetime in the tooltip. Same `hostContext` badge as every other host chip.
 */
export function MachineHostBadge({ match }: { match: MachineMatch }): React.JSX.Element {
  const state = getMachineDisplayState(match.machine.state)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="hostContext" className="max-w-[8rem]">
          <MachineStateDot state={state} />
          <span className="truncate">{match.machine.name}</span>
          {state === 'gone' ? (
            <span className="shrink-0 text-destructive">{getMachineDisplayStateLabel(state)}</span>
          ) : null}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {describeMachine(match)}
      </TooltipContent>
    </Tooltip>
  )
}
