import { useMemo } from 'react'
import type { TerminalTab } from '../../../../shared/types'

function getTerminalParkingInputsKey(terminalTabs: readonly TerminalTab[]): string {
  return JSON.stringify(terminalTabs.map((tab) => [tab.id, tab.ptyId, tab.pendingActivationSpawn]))
}

export function useWorktreeParkTerminalTabs(
  terminalTabs: readonly TerminalTab[],
  coldParkTerminalPanes: boolean
): readonly TerminalTab[] {
  const parkingInputsKey = coldParkTerminalPanes
    ? getTerminalParkingInputsKey(terminalTabs)
    : terminalTabs
  // eslint-disable-next-line react-hooks/exhaustive-deps -- decorative tab publications must not retrigger dominated pre-gate work.
  return useMemo(() => terminalTabs, [parkingInputsKey])
}
