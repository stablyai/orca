import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import type { TerminalPaneAgentIdCopy } from './terminal-pane-context-menu-types'
import type { PaneCwdMap } from '../layout/split/resolve-split-cwd'
import { copyAgentSessionContextFromPane } from '../clipboard/terminal-agent-session-context-copy'
import {
  prepareAgentSessionForkFromPane,
  type PreparedAgentSessionFork
} from '../session-fork/terminal-agent-session-fork'
import { prepareAgentSessionContinuationFromPane } from '../session-continuation/terminal-agent-session-continuation'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session/context/agent-session-continuation'

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

// Copy standalone bounded context without fork framing or opening the fork dialog (#5020).
export const copyAgentSessionContextFromMenuPane = async (
  pane: ManagedPane | null
): Promise<void> => {
  if (!pane) {
    return
  }
  await copyAgentSessionContextFromPane(pane)
}

export function createTerminalPaneMenuAgentSessionActions({
  agentSessionContext,
  resolveMenuPane
}: {
  agentSessionContext: TerminalPaneMenuAgentSessionContext
  resolveMenuPane: () => ManagedPane | null
}) {
  const onForkAgentSession = async (): Promise<void> =>
    forkAgentSessionFromMenuPane(agentSessionContext, resolveMenuPane())

  const onContinueAgentSessionInNewSession = (): void =>
    continueAgentSessionFromMenuPane(agentSessionContext, resolveMenuPane())

  const onCopyAgentSessionContext = async (): Promise<void> =>
    copyAgentSessionContextFromMenuPane(resolveMenuPane())
  return { onForkAgentSession, onContinueAgentSessionInNewSession, onCopyAgentSessionContext }
}

/** Copy Session ID shows whenever the pane names a provider session; Copy Orca Session ID only where
 *  the pane's host can answer (see `canPaneOfferAgentId`). */
export function terminalPaneMenuAgentIdProps(
  contextMenu: {
    onCopyAgentSessionId: () => Promise<void>
    agentIdCopy: TerminalPaneAgentIdCopy
  },
  menuAgentIds: { sessionId: string | null; agentIdAvailable: boolean }
): {
  canCopyAgentSessionId: boolean
  onCopyAgentSessionId: () => void
  agentIdCopy?: TerminalPaneAgentIdCopy
} {
  return {
    canCopyAgentSessionId: menuAgentIds.sessionId !== null,
    onCopyAgentSessionId: () => void contextMenu.onCopyAgentSessionId(),
    ...(menuAgentIds.agentIdAvailable ? { agentIdCopy: contextMenu.agentIdCopy } : {})
  }
}
