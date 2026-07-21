import { toast } from 'sonner'
import { useAppStore } from '@/store'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import { createWebRuntimeSessionTerminal } from '@/runtime/web-runtime-session'
import type { Tab, TuiAgent } from '../../../shared/types'
import { translate } from '@/i18n/i18n'

/**
 * Launch an agent terminal on the web runtime host instead of a local tab.
 *
 * Why: paired web tabs are host-owned, so this path never creates a local tab
 * (callers return tabId: null). The host's provider-session claim reuses an
 * existing owner; its authoritative snapshot replaces any stale client row.
 */
export function launchAgentInWebHostTab(args: {
  agent: TuiAgent
  worktreeId: string
  environmentId: string | null
  groupId?: string
  hasPrompt: boolean
  startupPlan: AgentStartupPlan
  viewMode?: Tab['viewMode']
  onPromptDelivered?: () => void
}): void {
  const {
    agent,
    worktreeId,
    environmentId,
    groupId,
    hasPrompt,
    startupPlan,
    viewMode,
    onPromptDelivered
  } = args
  void createWebRuntimeSessionTerminal({
    worktreeId,
    environmentId,
    targetGroupId: groupId,
    activate: true,
    ...(viewMode ? { viewMode } : {}),
    ...(hasPrompt
      ? {
          command: startupPlan.launchCommand,
          ...(startupPlan.env ? { env: startupPlan.env } : {}),
          launchConfig: startupPlan.launchConfig,
          launchAgent: agent,
          ...(startupPlan.startupCommandDelivery
            ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
            : {})
        }
      : { agent })
  }).then((created) => {
    if (!created) {
      toast.error(
        translate(
          'auto.lib.launch.agent.in.new.tab.11cce5cc77',
          'Could not launch {{value0}} in a new terminal.',
          { value0: agent }
        )
      )
      return
    }
    useAppStore.getState().setActiveTabType('terminal')
    if (hasPrompt) {
      onPromptDelivered?.()
    }
  })
}
