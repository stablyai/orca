import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import {
  collectLeafIdsInOrder,
  resolveRootlessTerminalLayoutLeafId
} from '../terminal-pane/terminal-layout-leaf-ids'
import {
  resolvePaneAgentSessionId,
  type PaneAgentSessionIdState
} from '../terminal-pane/pane-agent-session-id'

/**
 * Pane a tab-level identifier copy acts on: the focused one, so a split tab
 * copies what the user is looking at. Falls back to the first pane when the
 * focus is stale (a close/hydration race can leave it pointing at a removed
 * leaf) or absent (tab restored but never activated).
 */
export function resolveTabIdentityLeafId(
  layout: TerminalLayoutSnapshot | undefined
): string | null {
  if (!layout) {
    return null
  }
  // Why: a rootless snapshot is a tab restored but never hydrated, where the persisted focus is
  // the only signal. Once there is a tree, a leaf absent from it is gone, so it must not pass.
  // normalizeTerminalLayoutSnapshot draws the same line on `root`.
  if (!layout.root) {
    return resolveRootlessTerminalLayoutLeafId(layout)
  }
  const leafIds = collectLeafIdsInOrder(layout.root).filter(isTerminalLeafId)
  const activeLeafId = layout.activeLeafId
  if (activeLeafId && isTerminalLeafId(activeLeafId) && leafIds.includes(activeLeafId)) {
    return activeLeafId
  }
  return leafIds[0] ?? null
}

/**
 * Provider-owned session id this tab can be resumed by — the id CLI `--resume` takes; Orca
 * terminal ids are not agent-session ids. Resolved only when the whole tab owns exactly one
 * session, because a tab-level copy has no way to say which pane it picked. A split tab running
 * two agents therefore offers nothing here and is copied from each pane's own menu instead.
 */
export function resolveTabAgentSessionId(args: {
  tabId: string
  layout: TerminalLayoutSnapshot | undefined
  state: PaneAgentSessionIdState
}): string | null {
  const sessionIds = new Set<string>()
  for (const leafId of tabTerminalLeafIds(args.layout)) {
    // Why: per-pane resolution is delegated so this menu and the pane's own menu never disagree
    // about whether a session is resumable (shell-foreground and unconfirmed-restore gates).
    const sessionId = resolvePaneAgentSessionId(args.state, makePaneKey(args.tabId, leafId))
    if (sessionId) {
      sessionIds.add(sessionId)
    }
  }
  const [only] = sessionIds
  return sessionIds.size === 1 ? only : null
}

/**
 * Terminal panes the tab currently has. A rootless snapshot has no tree to walk, so its one
 * resolvable pane is the identity leaf - keeping both menu items in agreement about whether a
 * restored-but-unhydrated tab has a pane at all.
 */
function tabTerminalLeafIds(layout: TerminalLayoutSnapshot | undefined): string[] {
  if (layout?.root) {
    return collectLeafIdsInOrder(layout.root).filter(isTerminalLeafId)
  }
  const identityLeafId = resolveTabIdentityLeafId(layout)
  return identityLeafId ? [identityLeafId] : []
}
