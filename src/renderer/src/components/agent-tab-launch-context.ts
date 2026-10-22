import { toast } from 'sonner'
import { useAppStore } from '../store'
import {
  captureNativeChatComposerFocusIntent,
  type NativeChatComposerFocusIntent
} from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { selectFloatingWorkspacePanelVisible } from '@/store/floating-workspace-panel-selector'
import { translate } from '@/i18n/i18n'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { TerminalAgentTabShortcut } from './terminal-agent-tab-shortcut'

/** Where a new-agent-tab shortcut was pressed: the pane it targets and the focus it may take. */
export type AgentTabLaunchContext = {
  groupId: string | undefined
  focusIntent: NativeChatComposerFocusIntent
}

export function captureAgentTabLaunchContext(worktreeId: string): AgentTabLaunchContext {
  const state = useAppStore.getState()
  return {
    groupId:
      state.activeGroupIdByWorktree[worktreeId] ?? state.groupsByWorktree[worktreeId]?.[0]?.id,
    focusIntent: captureNativeChatComposerFocusIntent()
  }
}

export function reportNoAgentCliDetected(): void {
  toast.message(
    translate(
      'auto.components.Terminal.5b2c1a9e44',
      'No agent CLI detected — install one or pick a default agent in Settings.'
    )
  )
}

export function launchAgentTabFromShortcut(
  worktreeId: string,
  agent: TuiAgent,
  context?: AgentTabLaunchContext
): void {
  const { groupId, focusIntent } = context ?? captureAgentTabLaunchContext(worktreeId)
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

/** The new-agent-tab shortcut while the floating panel owns it: same launch, in that panel. */
export function launchFloatingWorkspaceAgentShortcut(
  shortcut: Pick<TerminalAgentTabShortcut, 'agent' | 'pendingAgent'>
): void {
  const { agent, pendingAgent } = shortcut
  if (!agent && !pendingAgent) {
    reportNoAgentCliDetected()
    return
  }
  const context = captureAgentTabLaunchContext(FLOATING_TERMINAL_WORKTREE_ID)
  if (agent) {
    launchAgentTabFromShortcut(FLOATING_TERMINAL_WORKTREE_ID, agent, context)
    return
  }
  void pendingAgent?.then((settledAgent) => {
    // Why: a slow host probe must not open a tab in a panel the user has since closed.
    const panelVisible = selectFloatingWorkspacePanelVisible(useAppStore.getState())
    if (settledAgent && panelVisible) {
      launchAgentTabFromShortcut(FLOATING_TERMINAL_WORKTREE_ID, settledAgent, context)
      return
    }
    context.focusIntent.cancel()
    if (panelVisible) {
      reportNoAgentCliDetected()
    }
  })
}
