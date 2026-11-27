import { toast } from 'sonner'
import { launchAgentInNewTabWithOutcome } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab'

import { createNonSecureContextUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import { translate } from '@/i18n/i18n'
import { selectFloatingWorkspacePanelVisible } from '@/store/workspaces/floating/floating-workspace-panel-selector'
import { useAppStore } from '../../../store/index'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/workspace/identity/floating-workspace-id'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { LaunchSource } from '../../../../../shared/telemetry/schemas/telemetry-property-schemas'
import {
  captureAgentTabLaunchContext,
  type AgentTabLaunchContext
} from '../../../lib/agent-session/launch/pane/agent-tab-launch-context'
import {
  resolveTerminalAgentTabShortcut,
  type TerminalAgentTabShortcut
} from './terminal-agent-tab-shortcut'
import { getDetectionTargetIdentityForWorktree } from '@/lib/agent-session/launch/inventory/agent-detection-target-inventory'

function launchAgentTab(
  worktreeId: string,
  agent: TuiAgent,
  { groupId, focusIntent }: AgentTabLaunchContext,
  launchSource: LaunchSource
): void {
  launchAgentInNewTabWithOutcome({
    requestId: createNonSecureContextUuid(),
    focusIntent,
    agent,
    worktreeId,
    groupId,
    launchSource
  })
}

/** Launch a resolved new-agent-tab shortcut in the pane it was pressed in, waiting on detection if needed. */
export function launchAgentTabShortcut(
  worktreeId: string,
  { agent, pendingAgent }: Pick<TerminalAgentTabShortcut, 'agent' | 'pendingAgent'>,
  isTargetCurrent: () => boolean,
  { groupId, launchSource = 'shortcut' }: { groupId?: string; launchSource?: LaunchSource } = {}
): void {
  const context = captureAgentTabLaunchContext(worktreeId)
  context.groupId = groupId ?? context.groupId
  if (agent) {
    launchAgentTab(worktreeId, agent, context, launchSource)
    return
  }
  void pendingAgent?.then((settledAgent) => {
    // Why: a slow host probe must not open a tab in a pane (or on a host) the user has since left.
    const targetCurrent = isTargetCurrent()
    if (settledAgent && targetCurrent) {
      launchAgentTab(worktreeId, settledAgent, context, launchSource)
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

export function launchDefaultAgentTabFromTabBar(worktreeId: string, groupId: string): void {
  const state = useAppStore.getState()
  const detectionTarget = getDetectionTargetIdentityForWorktree(state, worktreeId)
  const shortcut = resolveTerminalAgentTabShortcut({
    activeWorktreeId: worktreeId,
    keybindings: state.keybindings,
    matchShortcut: (actionId) => actionId === 'tab.newAgent'
  })
  launchAgentTabShortcut(
    worktreeId,
    shortcut,
    () => {
      const latest = useAppStore.getState()
      const workspaceVisible =
        worktreeId === FLOATING_TERMINAL_WORKTREE_ID
          ? selectFloatingWorkspacePanelVisible(latest)
          : latest.activeWorktreeId === worktreeId
      return (
        workspaceVisible &&
        latest.activeGroupIdByWorktree[worktreeId] === state.activeGroupIdByWorktree[worktreeId] &&
        getDetectionTargetIdentityForWorktree(latest, worktreeId) === detectionTarget
      )
    },
    { groupId, launchSource: 'tab_bar_quick_launch' }
  )
}

export function launchFloatingWorkspaceAgentShortcut(
  shortcut: Pick<TerminalAgentTabShortcut, 'agent' | 'pendingAgent'>
): void {
  launchAgentTabShortcut(FLOATING_TERMINAL_WORKTREE_ID, shortcut, () =>
    selectFloatingWorkspacePanelVisible(useAppStore.getState())
  )
}
