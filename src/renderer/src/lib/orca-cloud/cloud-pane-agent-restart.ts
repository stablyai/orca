// The one Restart for an Orca Cloud pane's agent (RA-11): the sign-in strip's "Restart Claude" and the
// woke-up strip's both run it. It resumes the pane's own conversation when it has one and starts
// fresh when the resume finds none (RA-11e); the strip over the pane shows Restarting, then the
// outcome, so it never ends silently.
import { useAppStore } from '@/store'
import type { HostAgentSignInAgent } from '../../../../shared/host-agent-sign-in-status'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { beginCloudAgentRestart } from './cloud-agent-restart-attempt'
import { watchCloudAgentRestartPane } from './cloud-agent-restart-pane-watch'

export function startCloudPaneAgentRestart(args: {
  paneKey: string
  worktreeId: string
  ptyId: string
  agent: HostAgentSignInAgent
  resumable: boolean
}): void {
  const { paneKey, worktreeId, ptyId, agent, resumable } = args
  // Never automatic: the person asked.
  beginCloudAgentRestart(paneKey, { agent, resumable, ptyId }, () =>
    useAppStore.getState().queuePaneAccountRestarts([ptyId], agent)
  )
  watchCloudAgentRestartPane(paneKey, worktreeId, agent)
}

/** The same Restart for a pane by its tab and leaf, read from the store at click time. */
export function restartCloudPaneAgent(args: {
  tabId: string
  leafId: string
  worktreeId: string
  agent: HostAgentSignInAgent
}): void {
  const state = useAppStore.getState()
  const paneKey = makePaneKey(args.tabId, args.leafId)
  const ptyId = state.terminalLayoutsByTabId[args.tabId]?.ptyIdsByLeafId?.[args.leafId]
  if (!ptyId) {
    return
  }
  startCloudPaneAgentRestart({
    paneKey,
    worktreeId: args.worktreeId,
    ptyId,
    agent: args.agent,
    resumable: Boolean(state.agentStatusByPaneKey[paneKey]?.providerSession)
  })
}
