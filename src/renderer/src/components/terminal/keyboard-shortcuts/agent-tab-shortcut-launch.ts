import { toast } from 'sonner'
import { launchAgentInNewTabWithOutcome } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab'

import { createNonSecureContextUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import { translate } from '@/i18n/i18n'
import { selectFloatingWorkspacePanelVisible } from '@/store/workspaces/floating/floating-workspace-panel-selector'
import { useAppStore } from '../../../store/index'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/workspace/identity/floating-workspace-id'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import {
  captureAgentTabLaunchContext,
  type AgentTabLaunchContext
} from '../../../lib/agent-session/launch/pane/agent-tab-launch-context'
import type { TerminalAgentTabShortcut } from './terminal-agent-tab-shortcut'
import { launchCustomAcpAgentChat } from '@/lib/agent-session/launch/new-tab/launch-custom-acp-agent-chat'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'

function launchAgentTab(
  worktreeId: string,
  agent: TuiAgent,
  { groupId, focusIntent }: AgentTabLaunchContext
): void {
  launchAgentInNewTabWithOutcome({
    requestId: createNonSecureContextUuid(),
    focusIntent,
    agent,
    worktreeId,
    groupId,
    launchSource: 'shortcut'
  })
}

/** Launch a resolved new-agent-tab shortcut in the pane it was pressed in, waiting on detection if needed. */
export function launchAgentTabShortcut(
  worktreeId: string,
  {
    agent,
    pendingAgent,
    customAgent
  }: Pick<TerminalAgentTabShortcut, 'agent' | 'pendingAgent' | 'customAgent'>,
  isTargetCurrent: () => boolean
): void {
  const context = captureAgentTabLaunchContext(worktreeId)
  if (customAgent) {
    launchCustomAcpAgentChat({
      agent: customAgent.id,
      worktreeId,
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      groupId: context.groupId,
      focusIntent: context.focusIntent
    })
    return
  }
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
  shortcut: Pick<TerminalAgentTabShortcut, 'agent' | 'pendingAgent' | 'customAgent'>
): void {
  launchAgentTabShortcut(FLOATING_TERMINAL_WORKTREE_ID, shortcut, () =>
    selectFloatingWorkspacePanelVisible(useAppStore.getState())
  )
}
