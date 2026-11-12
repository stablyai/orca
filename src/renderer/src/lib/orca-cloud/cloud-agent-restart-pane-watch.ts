// RA-11: a Restart must never vanish without a result. If its pane goes away while the restart runs
// (or after it failed), the strip has nowhere to show; say so in a toast that names the workspace.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { resolveWorktreeDisplayName } from '@/lib/workspace/display/worktree-default-display-name'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { TerminalPaneLayoutNode } from '../../../../shared/workspace-layout/terminal-tab-types'
import {
  HOST_AGENT_SIGN_IN_AGENT_NAME,
  type HostAgentSignInAgent
} from '../../../../shared/host-agent-sign-in-status'
import { cloudAgentRestartAttempt, dismissCloudAgentRestart } from './cloud-agent-restart-attempt'

function hasLeaf(node: TerminalPaneLayoutNode | null | undefined, leafId: string): boolean {
  if (!node) {
    return false
  }
  return node.type === 'leaf'
    ? node.leafId === leafId
    : hasLeaf(node.first, leafId) || hasLeaf(node.second, leafId)
}

/** Whether the pane (its tab and its leaf) still exists. A restart only rebinds the leaf's PTY. */
export function restartPaneExists(state: AppState, paneKey: string): boolean {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return false
  }
  const tabExists = Object.values(state.tabsByWorktree).some((tabs) =>
    tabs.some((tab) => tab.id === parsed.tabId)
  )
  return tabExists && hasLeaf(state.terminalLayoutsByTabId[parsed.tabId]?.root, parsed.leafId)
}

/** Watch the pane for the attempt's life; returns the unsubscribe. */
export function watchCloudAgentRestartPane(
  paneKey: string,
  worktreeId: string,
  agent: HostAgentSignInAgent
): () => void {
  const unsubscribe = useAppStore.subscribe((state) => {
    if (!cloudAgentRestartAttempt(paneKey, 0)) {
      unsubscribe()
      return
    }
    if (restartPaneExists(state, paneKey)) {
      return
    }
    unsubscribe()
    dismissCloudAgentRestart(paneKey)
    const worktree = state.getKnownWorktreeById(worktreeId)
    const workspace = worktree ? resolveWorktreeDisplayName(worktree) : worktreeId
    toast.error(
      translate(
        'agentSignInStrip.restartFailedIn',
        'Couldn’t restart {{agent}} in {{workspace}}.',
        {
          agent: HOST_AGENT_SIGN_IN_AGENT_NAME[agent],
          workspace
        }
      ),
      {
        action: {
          label: translate('agentSignInStrip.openWorkspace', 'Open workspace'),
          onClick: () => activateAndRevealWorktree(worktreeId)
        }
      }
    )
  })
  return unsubscribe
}
