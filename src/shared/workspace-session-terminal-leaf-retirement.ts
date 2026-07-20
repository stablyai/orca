import { makePaneKey } from './stable-pane-id'
import { retireTerminalLayoutLeaf } from './terminal-layout-leaf-retirement'
import type { WorkspaceSessionState } from './types'
import { closeTerminalTabInWorkspaceSession } from './workspace-session-terminal-tab-close'

export type WorkspaceSessionTerminalLeafRetirement = {
  session: WorkspaceSessionState
  retired: boolean
  parentRemoved: boolean
}

export function retireTerminalLeafInWorkspaceSession(
  session: WorkspaceSessionState,
  worktreeId: string,
  args: { parentTabId: string; leafId: string; expectedPtyId: string }
): WorkspaceSessionTerminalLeafRetirement {
  const layout = session.terminalLayoutsByTabId[args.parentTabId]
  const retirement = retireTerminalLayoutLeaf(layout, args)
  if (!retirement) {
    return { session, retired: false, parentRemoved: false }
  }
  if (!retirement.layout) {
    const closed = closeTerminalTabInWorkspaceSession(session, worktreeId, args.parentTabId, {
      allowPinnedRetirement: true
    })
    return {
      session: closed.closed ? closed.session : session,
      retired: closed.closed,
      parentRemoved: closed.closed
    }
  }

  const replacementPtyId =
    retirement.layout.ptyIdsByLeafId?.[retirement.layout.activeLeafId ?? ''] ??
    Object.values(retirement.layout.ptyIdsByLeafId ?? {})[0] ??
    null
  const tabs = (session.tabsByWorktree[worktreeId] ?? []).map((tab) =>
    tab.id === args.parentTabId && tab.ptyId === args.expectedPtyId
      ? { ...tab, ptyId: replacementPtyId }
      : tab
  )
  const remoteSessionIdsByTabId = { ...session.remoteSessionIdsByTabId }
  if (remoteSessionIdsByTabId[args.parentTabId] === args.expectedPtyId) {
    if (replacementPtyId) {
      remoteSessionIdsByTabId[args.parentTabId] = replacementPtyId
    } else {
      delete remoteSessionIdsByTabId[args.parentTabId]
    }
  }
  const sleepingAgentSessionsByPaneKey = { ...session.sleepingAgentSessionsByPaneKey }
  delete sleepingAgentSessionsByPaneKey[makePaneKey(args.parentTabId, args.leafId)]
  return {
    retired: true,
    parentRemoved: false,
    session: {
      ...session,
      tabsByWorktree: { ...session.tabsByWorktree, [worktreeId]: tabs },
      terminalLayoutsByTabId: {
        ...session.terminalLayoutsByTabId,
        [args.parentTabId]: retirement.layout
      },
      remoteSessionIdsByTabId,
      sleepingAgentSessionsByPaneKey
    }
  }
}
