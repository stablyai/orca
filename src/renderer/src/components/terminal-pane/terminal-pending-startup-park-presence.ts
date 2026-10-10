import { useShallow } from 'zustand/react/shallow'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { useAppStore } from '../../store'

const EMPTY_PENDING_STARTUP: Readonly<Record<string, unknown>> = Object.freeze({})

/** Park policy only asks whether *these* tabs have a pending startup, so this
 *  subscribes to a worktree-scoped presence record instead of the app-global one:
 *  a startup write for any other worktree then cannot re-render this one. Empty
 *  in the steady state, so the subscription allocates nothing. */
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
