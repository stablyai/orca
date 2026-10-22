import type { AgentCompletionStatusSnapshot } from '@/components/terminal-pane/agent-completion-coordinator-types'
import { resolveTuiAgentLaunchArgs } from '../../../shared/tui-agent-launch-defaults'

const ANTIGRAVITY_SKIP_PERMISSIONS_ARG = '--dangerously-skip-permissions'

type AntigravityPermissionBannerState = {
  agentLaunchConfigByPaneKey?: Record<
    string,
    {
      launchConfig?: { agentArgs?: string }
      identity?: { agentType?: string }
    }
  >
  settings?: {
    agentDefaultArgs?: Readonly<Record<string, string | undefined>> | null
  } | null
}

function resolvedAntigravityLaunchArgs(
  paneKey: string,
  state: AntigravityPermissionBannerState
): string | undefined {
  const registered = state.agentLaunchConfigByPaneKey?.[paneKey]
  if (registered?.identity?.agentType === 'antigravity') {
    return registered.launchConfig?.agentArgs
  }
  if (state.settings?.agentDefaultArgs) {
    return resolveTuiAgentLaunchArgs('antigravity', state.settings.agentDefaultArgs)
  }
  return undefined
}

/** True when an Antigravity `ask_permission` hook is the auto-approve that precedes yolo. */
export function isAntigravityAskPermissionAutoApproved(
  paneKey: string,
  agentStatus: Pick<AgentCompletionStatusSnapshot, 'agentType' | 'toolName'>,
  state: AntigravityPermissionBannerState
): boolean {
  if (agentStatus.agentType !== 'antigravity' || agentStatus.toolName !== 'ask_permission') {
    return false
  }
  const args = resolvedAntigravityLaunchArgs(paneKey, state)
  return typeof args === 'string' && args.includes(ANTIGRAVITY_SKIP_PERMISSIONS_ARG)
}
