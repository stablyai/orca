import { toast } from 'sonner'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { translate } from '@/i18n/i18n'
import { selectFloatingWorkspacePanelVisible } from '@/store/floating-workspace-panel-selector'
import { useAppStore } from '../store'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  captureAgentTabLaunchContext,
  type AgentTabLaunchContext
} from './agent-tab-launch-context'
import type { TerminalAgentTabShortcut } from './terminal-agent-tab-shortcut'

function launchAgentTab(
  worktreeId: string,
  agent: TuiAgent,
  { groupId, focusIntent }: AgentTabLaunchContext
): void {
  const result = launchAgentInNewTab({
    requestId: newAgentLaunchRequestId(),
    focusIntent,
    agent,
    worktreeId,
    groupId,
    launchSource: 'shortcut'
  })
  if (!result) {
    toast.error(
      translate(
        'auto.components.Terminal.e57db40c11',
        'Could not build launch command for {{value0}}.',
        { value0: agent }
      )
    )
  }
}

/** Launch a resolved new-agent-tab shortcut in the pane it was pressed in, waiting on detection if needed. */
export function launchAgentTabShortcut(
  worktreeId: string,
  { agent, pendingAgent }: Pick<TerminalAgentTabShortcut, 'agent' | 'pendingAgent'>,
  isTargetCurrent: () => boolean
): void {
  const context = captureAgentTabLaunchContext(worktreeId)
  if (agent) {
    launchAgentTab(worktreeId, agent, context)
    return
  }
  void pendingAgent?.then((settledAgent) => {
    // Why: a slow host probe must not open a tab in a pane (or on a host) the user has since left.
    const targetCurrent = isTargetCurrent()
    if (settledAgent && targetCurrent) {
      launchAgentTab(worktreeId, settledAgent, context)
      return
    }
    context.focusIntent.cancel()
    if (targetCurrent) {
      toast.message(
        translate(
          'auto.components.Terminal.5b2c1a9e44',
          'No agent CLI detected — install one or pick a default agent in Settings.'
        )
      )
    }
  })
}

export function launchFloatingWorkspaceAgentShortcut(
  shortcut: Pick<TerminalAgentTabShortcut, 'agent' | 'pendingAgent'>
): void {
  launchAgentTabShortcut(FLOATING_TERMINAL_WORKTREE_ID, shortcut, () =>
    selectFloatingWorkspacePanelVisible(useAppStore.getState())
  )
}
