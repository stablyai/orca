import { buildAgentSessionRulesPrompt, buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import type { resolveAgentBackgroundLaunchHost } from '@/lib/agent-background-session-launch-host'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'
import type { GlobalSettings, TuiAgent } from '../../../shared/types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { normalizeAgentSessionRulesSettings } from '../../../shared/agent-session-rules'

export async function prepareAgentBackgroundSessionStartup(args: {
  agent: TuiAgent
  prompt?: string | null
  worktreePath: string
  repoId: string | null
  launchHost: ReturnType<typeof resolveAgentBackgroundLaunchHost>
  executionHostId: ExecutionHostId
  settings: GlobalSettings | null | undefined
}) {
  const { agent, prompt, worktreePath, repoId, launchHost, executionHostId, settings } = args
  const clientDefaultAgentSessionRules = normalizeAgentSessionRulesSettings(
    settings?.agentSessionRules
  )
  const preflight = TUI_AGENT_CONFIG[agent].preflightTrust
  if (preflight && worktreePath && window.api.agentTrust?.markTrusted) {
    try {
      await window.api.agentTrust.markTrusted({
        preset: preflight,
        workspacePath: worktreePath,
        ...(launchHost.connectionId ? { connectionId: launchHost.connectionId } : {})
      })
    } catch {
      // Best-effort: the user can still accept the trust prompt.
    }
  }

  const trimmedPrompt = prompt?.trim() ?? ''
  const hasPrompt = trimmedPrompt.length > 0
  const isFollowupPath = TUI_AGENT_CONFIG[agent].promptInjectionMode === 'stdin-after-start'
  const pasteDraftAfterLaunch =
    hasPrompt && isFollowupPath
      ? buildAgentSessionRulesPrompt({
          agent,
          prompt: trimmedPrompt,
          repoId,
          connectionId: launchHost.connectionId ?? null,
          executionHostId
        })
      : null
  const startupPlan = buildAgentStartupPlan({
    agent,
    prompt: hasPrompt && !isFollowupPath ? trimmedPrompt : '',
    cmdOverrides: settings?.agentCmdOverrides ?? {},
    agentArgs: resolveTuiAgentLaunchArgs(agent, settings?.agentDefaultArgs),
    agentEnv: resolveTuiAgentLaunchEnv(agent, settings?.agentDefaultEnv),
    platform: launchHost.platform,
    shell: resolveLocalWindowsAgentStartupShell({
      platform: launchHost.platform,
      isRemote: launchHost.isRemote,
      terminalWindowsShell: settings?.terminalWindowsShell
    }),
    isRemote: launchHost.isRemote,
    allowEmptyPromptLaunch: !hasPrompt || isFollowupPath,
    repoId,
    connectionId: launchHost.connectionId ?? null,
    executionHostId
  })

  return {
    startupPlan,
    trimmedPrompt,
    hasPrompt,
    isFollowupPath,
    pasteDraftAfterLaunch,
    clientDefaultAgentSessionRules
  }
}
