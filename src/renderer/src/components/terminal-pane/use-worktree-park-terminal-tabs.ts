import { useRef } from 'react'
import type { TerminalTab } from '../../../../shared/types'

function haveSameTerminalParkingInputs(
  left: readonly TerminalTab[],
  right: readonly TerminalTab[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (tab, index) =>
        tab.id === right[index].id &&
        tab.ptyId === right[index].ptyId &&
        tab.pendingActivationSpawn === right[index].pendingActivationSpawn
    )
  )
}

export function useWorktreeParkTerminalTabs(
  terminalTabs: readonly TerminalTab[],
  coldParkTerminalPanes: boolean
): readonly TerminalTab[] {
  const stableTabsRef = useRef(terminalTabs)
  // Why: a dominant worktree park hides pre-gate churn from final-verdict damping.
  if (
    !coldParkTerminalPanes ||
    !haveSameTerminalParkingInputs(stableTabsRef.current, terminalTabs)
  ) {
    stableTabsRef.current = terminalTabs
  }
  return stableTabsRef.current
}
