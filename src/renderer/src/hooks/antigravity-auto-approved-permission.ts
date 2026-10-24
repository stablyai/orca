import type { AgentCompletionStatusSnapshot } from '@/components/terminal-pane/agent-completion-coordinator-types'
import { tuiAgentArgsBypassPermissions } from '../../../shared/tui-agent-launch-defaults'
import { resolveStartupShell } from '../../../shared/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'

type AntigravityPermissionBannerState = {
  agentLaunchConfigByPaneKey?: Record<
    string,
    {
      launchConfig?: { agentArgs?: string }
      identity?: { agentType?: string }
    }
  >
  settings?: {
    terminalWindowsShell?: string | null
  } | null
  terminalPlatform?: NodeJS.Platform
}

function registeredAntigravityLaunchArgs(
  paneKey: string,
  state: AntigravityPermissionBannerState
): string | undefined {
  const registered = state.agentLaunchConfigByPaneKey?.[paneKey]
  if (registered?.identity?.agentType !== 'antigravity') {
    return undefined
  }
  return registered.launchConfig?.agentArgs
}

/** True when this pane's registered Antigravity launch bypasses tool permissions. */
export function isAntigravityAskPermissionAutoApproved(
  paneKey: string,
  agentStatus: Pick<AgentCompletionStatusSnapshot, 'agentType' | 'toolName'>,
  state: AntigravityPermissionBannerState
): boolean {
  if (agentStatus.agentType !== 'antigravity' || agentStatus.toolName !== 'ask_permission') {
    return false
  }
  const args = registeredAntigravityLaunchArgs(paneKey, state)
  if (typeof args !== 'string') {
    return false
  }
  const platform = state.terminalPlatform ?? 'darwin'
  const shell = resolveStartupShell(
    platform,
    resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote: false,
      terminalWindowsShell: state.settings?.terminalWindowsShell
    })
  )
  return tuiAgentArgsBypassPermissions('antigravity', args, shell)
}
