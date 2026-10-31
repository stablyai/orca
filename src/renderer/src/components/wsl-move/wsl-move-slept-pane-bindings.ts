import { makePaneKey, isTerminalLeafId } from '../../../../shared/stable-pane-id'

type SleptPaneBinding = { paneKey: string; sessionId: string }

/**
 * Every pane this window still binds to a session but runs no terminal for: a Sleep keeps the
 * binding here for wake while main retires it, so without this a move reads none of their history.
 */
export function collectWslMoveSleptPaneBindings(state: {
  tabsByWorktree: Readonly<Record<string, readonly { id: string }[]>>
  terminalLayoutsByTabId: Readonly<Record<string, { ptyIdsByLeafId?: Record<string, string> }>>
  ptyIdsByTabId: Readonly<Record<string, readonly string[]>>
}): SleptPaneBinding[] {
  const bindings: SleptPaneBinding[] = []
  for (const tabs of Object.values(state.tabsByWorktree)) {
    for (const tab of tabs) {
      const live = new Set(state.ptyIdsByTabId[tab.id] ?? [])
      const layout = state.terminalLayoutsByTabId[tab.id]
      for (const [leafId, sessionId] of Object.entries(layout?.ptyIdsByLeafId ?? {})) {
        if (isTerminalLeafId(leafId) && sessionId && !live.has(sessionId)) {
          bindings.push({ paneKey: makePaneKey(tab.id, leafId), sessionId })
        }
      }
    }
  }
  return bindings
}
