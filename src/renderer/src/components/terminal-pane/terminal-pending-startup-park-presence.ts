import { useShallow } from 'zustand/react/shallow'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { useAppStore } from '../../store'

const EMPTY_PENDING_STARTUP: Readonly<Record<string, unknown>> = Object.freeze({})

/** Subscribe only to this worktree’s startup presence so unrelated startups cannot rerender it; empty steady state allocates nothing. */
export function usePendingStartupParkPresence(
  terminalTabs: readonly TerminalTab[]
): Readonly<Record<string, unknown>> {
  return useAppStore(
    useShallow((state) => {
      let presence: Record<string, true> | null = null
      for (const tab of terminalTabs) {
        if (state.pendingStartupByTabId[tab.id] !== undefined) {
          ;(presence ??= {})[tab.id] = true
        }
      }
      return presence ?? EMPTY_PENDING_STARTUP
    })
  )
}
