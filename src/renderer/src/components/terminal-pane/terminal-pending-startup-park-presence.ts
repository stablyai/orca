import { useMemo } from 'react'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { useAppStore } from '../../store'

const EMPTY_PENDING_STARTUP: Readonly<Record<string, unknown>> = Object.freeze({})
const TAB_ID_SEPARATOR = '\u0000'

/** Park policy only asks whether *these* tabs have a pending startup, so this
 *  subscribes to a worktree-scoped presence key instead of the app-global record:
 *  a startup write for any other worktree then cannot re-render this one. Empty
 *  in the steady state, so the subscription allocates nothing. */
export function usePendingStartupParkPresence(
  terminalTabs: readonly TerminalTab[]
): Readonly<Record<string, unknown>> {
  const pendingStartupTabIdsKey = useAppStore((state) => {
    const pendingStartup = state.pendingStartupByTabId
    let key = ''
    for (const tab of terminalTabs) {
      if (pendingStartup[tab.id] !== undefined) {
        key += key === '' ? tab.id : `${TAB_ID_SEPARATOR}${tab.id}`
      }
    }
    return key
  })
  return useMemo(() => {
    if (pendingStartupTabIdsKey === '') {
      return EMPTY_PENDING_STARTUP
    }
    const presence: Record<string, true> = {}
    for (const tabId of pendingStartupTabIdsKey.split(TAB_ID_SEPARATOR)) {
      presence[tabId] = true
    }
    return presence
  }, [pendingStartupTabIdsKey])
}
