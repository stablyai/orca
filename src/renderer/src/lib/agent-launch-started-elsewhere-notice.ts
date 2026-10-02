import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { getAgentLabel } from '@/lib/agent-catalog'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { showWorkspaceGoToToast } from '@/lib/workspace-go-to-toast'
import type { TuiAgent } from '../../../shared/tui-agent'

/**
 * A launched agent's tab appeared in a workspace the user had left: it stays there, and this offers
 * the way back. `tab` is the terminal the reveal created, when one did.
 */
export function showAgentLaunchStartedElsewhereNotice(args: {
  agent: TuiAgent
  worktreeId: string
  tab?: { tabId: string; leafId: string | null }
}): void {
  const worktree = useAppStore.getState().getKnownWorktreeById(args.worktreeId)
  if (!worktree) {
    return
  }
  const { tab } = args
  showWorkspaceGoToToast(worktree, {
    title: ({ name }) =>
      translate('auto.lib.agent.launch.started.elsewhere.title', '{{agent}} started in {{name}}', {
        agent: getAgentLabel(args.agent),
        name
      }),
    ...(tab ? { afterOpen: () => activateTabAndFocusPane(tab.tabId, tab.leafId) } : {})
  })
}
