import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { PaneCwdMap } from './resolve-split-cwd'
import {
  copyAgentSessionContextFromPane,
  prepareAgentSessionForkFromPane,
  type PreparedAgentSessionFork
} from './terminal-agent-session-fork'
import { prepareAgentSessionContinuationFromPane } from './terminal-agent-session-continuation'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'

export type TerminalPaneMenuAgentSessionContext = {
  paneCwdRef: React.RefObject<PaneCwdMap>
  tabId: string
  worktreeId: string
  groupId: string | null
  fallbackCwd: string
  onAgentSessionForkReady: (fork: PreparedAgentSessionFork) => void
  onAgentSessionContinuationReady: (request: AgentSessionContinuationRequest) => void
}

export const forkAgentSessionFromMenuPane = async (
  context: TerminalPaneMenuAgentSessionContext,
  pane: ManagedPane | null
): Promise<void> => {
  if (!pane) {
    return
  }
  const { tabId, worktreeId, groupId } = context
  const fork = prepareAgentSessionForkFromPane({ pane, tabId, worktreeId, groupId })
  if (fork) {
    context.onAgentSessionForkReady(fork)
  }
}

export const continueAgentSessionFromMenuPane = (
  context: TerminalPaneMenuAgentSessionContext,
  pane: ManagedPane | null
): void => {
  if (!pane) {
    return
  }
  const { tabId, worktreeId, groupId, fallbackCwd } = context
  const initialCwd = context.paneCwdRef.current.get(pane.id)?.cwd || fallbackCwd
  const request = prepareAgentSessionContinuationFromPane({
    pane,
    tabId,
    worktreeId,
    groupId,
    workspacePath: fallbackCwd,
    initialCwd
  })
  if (request) {
    context.onAgentSessionContinuationReady(request)
  }
}

// Why: the captured session transcript is often wanted on its own — to paste
// into another tool — so copy the bounded transcript directly, without the
// fork prompt's framing or the fork dialog detour (issue #5020).
export const copyAgentSessionContextFromMenuPane = async (
  pane: ManagedPane | null
): Promise<void> => {
  if (!pane) {
    return
  }
  await copyAgentSessionContextFromPane(pane)
}
