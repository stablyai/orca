import React from 'react'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import {
  getMachineDisplayStateLabel,
  type MachineDisplayState
} from '@/lib/machines/machine-display-state'

/** A machine's state dot; color only carries state, so every other surface stays monochrome. */
export function MachineStateDot({ state }: { state: MachineDisplayState }): React.JSX.Element {
  if (state === 'starting') {
    return <LoadingSpinner className="size-3 shrink-0 self-center text-muted-foreground" />
  }
  return (
    <span
      aria-hidden="true"
      data-state={state}
      className="size-1.5 shrink-0 self-center rounded-full data-[state=archived]:hidden data-[state=error]:bg-destructive data-[state=gone]:bg-destructive data-[state=running]:bg-status-success data-[state=sleeping]:ring-1 data-[state=sleeping]:ring-inset data-[state=sleeping]:ring-muted-foreground data-[state=unreachable]:bg-status-warning"
    />
  )
}

/** Dot plus the state word, so state never rests on color alone; sits on the text baseline. */
export function MachineStateLabel({ state }: { state: MachineDisplayState }): React.JSX.Element {
  return (
    <span
      data-state={state}
      className="inline-flex shrink-0 items-baseline gap-1.5 text-xs text-muted-foreground data-[state=error]:text-destructive data-[state=gone]:text-destructive"
    >
      <MachineStateDot state={state} />
      {getMachineDisplayStateLabel(state)}
    </span>
  )
}
